"""Agen system-backed (PRD Bab 12): kerja deterministik, LLM tidak dipakai.

- Masa  (#42): kuota LLM tiap 10 dtk → QUOTA_UPDATE, alert ambang, turunkan paralelisme saat kuota menipis.
- Seiji (#48): kesehatan host tiap 30 dtk → SYSTEM_HEALTH, alert ambang, deteksi task macet.
- Zero  (#50): pembersihan log/pesan lama; selalu lewat satu approval HIGH (Cache_Cleaner).
"""
import asyncio
import logging
import os
import shutil
import time
from typing import Any

import httpx

from app.ws.gateway import bus

log = logging.getLogger(__name__)

QUOTA_LOW_PCT = 20
QUOTA_CRITICAL_PCT = 5
STUCK_MINUTES = 15
LOG_RETENTION_DAYS = 90
MESSAGE_RETENTION_DAYS = 30
ALERT_COOLDOWN_S = 15 * 60
HOST_CLEAR_MARGIN = 10


def host_health(path: str) -> dict[str, Any]:
    """CPU (load 1 menit / jumlah core), RAM, disk: stdlib Linux, tanpa psutil."""
    cpu = os.getloadavg()[0] / (os.cpu_count() or 1) * 100
    mem: dict[str, int] = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            mem[k] = int(v.split()[0])
    ram = (1 - mem["MemAvailable"] / mem["MemTotal"]) * 100
    du = shutil.disk_usage(path)
    return {"cpu_pct": round(min(cpu, 100), 1), "ram_pct": round(ram, 1), "disk_pct": round(du.used / du.total * 100, 1)}


def quota_view(snapshot: list[dict]) -> list[dict]:
    out = []
    for m in snapshot:
        pct = None if not m["rpd_limit"] else max(0, round(100 - m["rpd_used"] / m["rpd_limit"] * 100))
        out.append({**m, "rpd_pct_left": pct})
    return out


class Ops:
    def __init__(self, repo, router, orch, gate, workspace: str) -> None:
        self.repo, self.router, self.orch, self.gate = repo, router, orch, gate
        self.workspace = workspace
        self.default_active = orch.max_active
        self.alerted: set[str] = set()
        self.last_alert: dict[str, float] = {}
        self.last_health: dict[str, Any] | None = None

    def alert(self, key: str, level: str, code: str, message: str, agent_id: str | None = None) -> None:
        if key in self.alerted:
            return
        self.alerted.add(key)
        now = time.monotonic()
        if now - self.last_alert.get(key, -ALERT_COOLDOWN_S) < ALERT_COOLDOWN_S:
            return
        self.last_alert[key] = now
        bus.publish("SYSTEM_ALERT", {"level": level, "code": code, "message": message, "agent_id": agent_id})

    def clear(self, key: str) -> None:
        self.alerted.discard(key)

    def check_quota(self) -> list[dict]:
        models = quota_view(self.router.snapshot())
        bus.publish("QUOTA_UPDATE", {"models": models})
        primary = self.router.chains.get("T1_REASON", [None])[0]
        worst = 100
        for m in models:
            pct = m["rpd_pct_left"]
            if pct is None:
                continue
            key = f"quota:{m['model']}"
            if pct < QUOTA_LOW_PCT:
                self.alert(key, "CRITICAL" if pct < QUOTA_CRITICAL_PCT else "WARN", "QUOTA_LOW",
                           f"Kuota harian {m['model']} tinggal {pct}%", "agent_masa")
            else:
                self.clear(key)
            if m["model"] == primary:
                worst = pct
        self.orch.max_active = 3 if worst < QUOTA_LOW_PCT else self.default_active
        bus.publish_agent_state("agent_masa", emotion_icon="sweat" if worst < QUOTA_LOW_PCT else None)
        return models

    async def check_health(self) -> dict[str, Any]:
        h = await asyncio.to_thread(host_health, self.workspace)
        h["ws_clients"] = len(bus.clients)
        host = os.getenv("OLLAMA_HOST")
        if host:
            try:
                async with httpx.AsyncClient(timeout=3) as c:
                    h["ollama_up"] = (await c.get(f"{host}/api/tags")).status_code == 200
            except httpx.HTTPError:
                h["ollama_up"] = False
            if not h["ollama_up"]:
                self.alert("ollama", "CRITICAL", "OLLAMA_DOWN", "Ollama tidak merespons", "agent_seiji")
            else:
                self.clear("ollama")
        for key, limit in (("cpu_pct", 90), ("ram_pct", 85), ("disk_pct", 80)):
            if h[key] > limit:
                self.alert(f"host:{key}", "WARN", "HOST_PRESSURE", f"{key} {h[key]}% > {limit}%", "agent_seiji")
            elif h[key] < limit - HOST_CLEAR_MARGIN:
                self.clear(f"host:{key}")
        for t in await self.repo.stuck_tasks(STUCK_MINUTES):
            self.alert(f"stuck:{t['task_id']}", "WARN", "TASK_STUCK",
                       f"'{t['title']}' berjalan > {STUCK_MINUTES} menit", t["assigned_to"])
        pressured = any(k.startswith(("host:", "ollama")) for k in self.alerted)
        bus.publish_agent_state("agent_seiji", emotion_icon="exclaim" if pressured else None)
        bus.publish("SYSTEM_HEALTH", h)
        self.last_health = h
        return h

    async def propose_cleanup(self) -> bool | None:
        """Satu approval berisi ringkasan kandidat. None = tidak ada yang perlu dibersihkan."""
        counts = await self.repo.cleanup_counts(LOG_RETENTION_DAYS, MESSAGE_RETENTION_DAYS)
        if not any(counts.values()):
            return None
        bus.publish_agent_state("agent_zero", status="WAITING_APPROVAL", emotion_icon="hourglass")
        approved, _, _ = await self.gate.request(
            agent_id="agent_zero", task_id=None, tool_name="Cache_Cleaner",
            tool_input={"hapus": counts, "retensi_log_hari": LOG_RETENTION_DAYS,
                        "retensi_pesan_hari": MESSAGE_RETENTION_DAYS},
            reason="Penghapusan data permanen", justification="Pembersihan rutin sesuai kebijakan retensi PRD §14.5.")
        if approved:
            bus.publish_agent_state("agent_zero", status="WORKING", emotion_icon="sparkle")
            await self.repo.cleanup(LOG_RETENTION_DAYS, MESSAGE_RETENTION_DAYS)
        bus.publish_agent_state("agent_zero", status="IDLE", emotion_icon=None)
        return approved

    async def run(self) -> None:
        async def every(seconds: float, fn, first_delay: float = 0) -> None:
            await asyncio.sleep(first_delay)
            while True:
                try:
                    result = fn()
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    log.exception("ops %s gagal", getattr(fn, "__name__", fn))
                await asyncio.sleep(seconds)

        await asyncio.gather(
            every(10, self.check_quota),
            every(30, self.check_health, first_delay=2),
            every(6 * 3600, self.propose_cleanup, first_delay=300),
        )
