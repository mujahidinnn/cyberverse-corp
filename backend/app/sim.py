"""Scheduler + executor simulasi (F0, DEMO_MODE).

Scheduler di sini adalah yang dipakai F1 (PRD §13.6). Yang palsu hanya `simulate_task` dan
`plan_goal`: keduanya diganti panggilan CrewAI + LLMRouter saat orkestrator masuk.
"""
import asyncio
import json
import logging
import random
import re
from dataclasses import dataclass

from ulid import ULID

from app.gate.approval import ApprovalGate, Risk, classify
from app.db.repo import Repo, _now
from app.ws.gateway import bus

log = logging.getLogger(__name__)
_pause = asyncio.sleep


DESIGN_EPIC = "DESAIN"
_PROVIDER = re.compile(r"litellm|rate.?limit|quota|kuota|semua model gagal|exception - \{|timeout|bad ?request", re.I)
SIMPLER = ("\n\nKerjakan versi paling sederhana dulu: satu hasil jadi yang bisa langsung dicek, tanpa tambahan "
           "di luar permintaan ini.")


def diagnose(errors: str) -> str:
    """Penyebab gagal dalam bahasa bos, dari pesan error teknis task."""
    if _PROVIDER.search(errors):
        return ("Layanan AI gratis yang dipakai tim sedang bermasalah atau kuotanya habis. Ini bukan karena "
                "permintaanmu; biasanya cukup dicoba lagi nanti.")
    if "ESCALATED_TO_HUMAN" in errors:
        return "Hasil kerja tim berulang kali ditolak reviewer dan tidak ada titik temu."
    if "Desain belum" in errors:
        return "Konsep desain belum mendapat persetujuanmu, jadi koding tidak dimulai."
    return "Pekerjaan berhenti di tengah jalan sebelum hasilnya jadi."


def fix_options(prompt: str, diagnosis: str, options: list[dict]) -> dict:
    """Rapikan pilihan perbaikan; selalu ada 'Ulangi persis' dan 'Sederhanakan' sebagai cadangan."""
    clean, seen = [], set()
    for o in options[:3]:
        p = str(o.get("prompt", "")).strip()[:4000]
        if len(p) >= 10 and p not in seen and o.get("title"):
            seen.add(p)
            clean.append({"title": str(o["title"])[:80], "detail": str(o.get("detail", ""))[:300], "prompt": p})
    simpler = (prompt + SIMPLER)[:4000]
    if len(clean) < 2 and simpler not in seen:
        clean.append({"title": "Sederhanakan dulu", "prompt": simpler,
                      "detail": "Tim membuat versi paling sederhana yang pasti jadi; tambahan bisa dilanjutkan setelahnya."})
    if prompt not in seen:
        clean.append({"title": "Ulangi persis seperti semula", "prompt": prompt,
                      "detail": "Perintah yang sama dikirim lagi. Cocok bila penyebabnya gangguan sementara."})
    return {"diagnosis": diagnosis, "options": clean}


@dataclass
class SimTool:
    name: str
    base_risk: Risk
    args: dict


GOAL_TEMPLATE = [
    ("T1", "agent_sora", "engineering", "Technical design & kontrak API", [], None,
     "Sora, rancang arsitekturnya. Sukses jika p95 < 100 ms."),
    ("T2", "agent_maya", "creative", "User stories & acceptance criteria", [], None,
     "Maya, terjemahkan ke user stories yang bisa dites."),
    ("T3", "agent_kenji", "engineering", "Implementasi REST API", ["T1"],
     SimTool("Python_Runner", Risk.MEDIUM, {"path": "src/api.py"}), "Kenji, endpoint sesuai kontrak ya."),
    ("T4", "agent_rin", "engineering", "Implementasi komponen UI", ["T1", "T2"],
     SimTool("React_Builder", Risk.MEDIUM, {"path": "src/App.tsx"}), "Rin, UI-nya ikut spesifikasi Yuki."),
    ("T5", "agent_kaito", "creative", "Headline peluncuran", ["T2"], None,
     "Kaito, 10 headline. Lima yang netral."),
    ("T6", "agent_neko_bot", "engineering", "Jalankan test suite", ["T3", "T4"],
     SimTool("PyTest_Runner", Risk.MEDIUM, {"path": "tests"}), "Neko-Bot, cari bug-nya."),
    ("T7", "agent_hiro", "engineering", "Deploy ke VPS", ["T6"],
     SimTool("Docker_CLI", Risk.HIGH, {"command": "docker compose up -d --build"}), "Hiro, deploy setelah test hijau."),
    ("T8", "agent_eri", "operations", "Indeks hasil kerja ke memori", ["T7"],
     SimTool("Chroma_Store", Risk.MEDIUM, {}), "Eri, simpan keputusan penting."),
]

LEAD_OF = {"engineering": "agent_aoi", "creative": "agent_luna", "operations": "agent_daichi"}


def no_emdash(text: str) -> str:
    """Keluaran LLM tanpa tanda pisah panjang: jeda kalimat jadi koma, rentang angka jadi tanda hubung."""
    text = re.sub(r"(?<=\d)\s*[\u2013\u2014]\s*(?=\d)", "-", text)
    return re.sub(r"\s*[\u2013\u2014]\s*", ", ", text)


KICKOFF_CLOSING = "Oke, sepakat. Langsung eksekusi, fokus ke hasil yang diminta."


class Orchestrator:
    def __init__(self, repo: Repo, gate: ApprovalGate, max_active: int) -> None:
        self.repo = repo
        self.gate = gate
        self.max_active = max_active
        self.running: dict[str, asyncio.Task] = {}
        self.tools: dict[str, SimTool] = {}

    async def agent_state(self, agent_id: str, status: str, **extra) -> None:
        await self.repo.set_agent(agent_id, status=status, emotion_icon=extra.get("emotion_icon"),
                                  current_task_id=extra.get("task_id"))
        bus.publish_agent_state(agent_id, status=status, **extra)

    def say(self, speaker: str, text: str, listener: str | None = None, style: str = "normal_white") -> None:
        text = re.sub(r"^\s*(#+|[-*]|\d+\.)\s+", "", text, flags=re.M)
        text = no_emdash(re.sub(r"[*_`]{1,3}", "", text).replace("\n", " ").strip())
        bus.publish("AGENT_DIALOGUE_SPOKEN", {"speaker_id": speaker, "listener_id": listener,
                                              "text": text, "bubble_style": style})

    async def task_event(self, task_id: str, created: bool = False) -> None:
        task = await self.repo.get_task(task_id)
        bus.publish("TASK_CREATED" if created else "TASK_UPDATED", task)

    async def plan_goal(self, goal_id: str) -> None:
        goal = await self.repo.get_goal(goal_id)
        await self.agent_state("agent_ren", "THINKING", emotion_icon="thought")
        await _pause(2)
        meeting_id, attendees = await self.kickoff_open(goal_id, ["agent_sora", "agent_maya"])
        self.say("agent_ren", f"Tim, goal kita: {goal['prompt'][:80]}", style="anime_command_gold")
        await _pause(2)

        initial = "PLANNED" if goal["review_before_run"] else "TODO"
        ids: dict[str, str] = {}
        for key, agent, division, title, deps, tool, handoff in GOAL_TEMPLATE:
            task_id = f"task_{ULID()}"
            ids[key] = task_id
            await self.repo.create_task({
                "task_id": task_id, "goal_id": goal_id, "title": title, "division": division,
                "assigned_to": agent, "reviewer_id": LEAD_OF.get(division), "created_by": "agent_ren",
                "status": initial, "priority": goal["priority"], "handoff_line": handoff,
            })
            for dep in deps:
                await self.repo.add_dependency(task_id, ids[dep])
            if tool:
                self.tools[task_id] = tool
            await self.task_event(task_id, created=True)

        self.say("agent_sora", "Engineering siap. Pembagian kerjanya sudah saya taruh di papan.", "agent_ren")
        await _pause(2)
        self.say("agent_ren", KICKOFF_CLOSING, style="anime_command_gold")
        minutes = await self.kickoff_minutes(goal_id, goal["prompt"][:80], "Kerjakan sesuai permintaan, tanpa tambahan.", [])
        await self.kickoff_close(meeting_id, goal_id, attendees, minutes)
        status = "AWAITING_START" if goal["review_before_run"] else "RUNNING"
        await self.repo.set_goal(goal_id, status, roadmap=[t[3] for t in GOAL_TEMPLATE])
        bus.publish("GOAL_UPDATED", {"goal_id": goal_id, "status": status})

    async def kickoff_open(self, goal_id: str, lead_ids: list[str]) -> tuple[str, list[str]]:
        """Ren dan lead yang terlibat berkumpul di Meeting Room sebelum pekerjaan dibagi."""
        meeting_id = f"meet_{ULID()}"
        attendees = list(dict.fromkeys(["agent_ren", *lead_ids]))
        await self.repo.create_meeting(meeting_id, "LEADS", ["Arahan goal", "Pembagian kerja"], goal_id)
        bus.publish("MEETING_STARTED", {"meeting_id": meeting_id, "type": "KICKOFF", "goal_id": goal_id,
                                        "participants": attendees, "remote": []})
        for i, agent_id in enumerate(attendees, 1):
            await self.repo.add_participant(meeting_id, agent_id, f"meeting_{i:02d}", False)
            await self.agent_state(agent_id, "MEETING", emotion_icon=None)
            bus.publish("AGENT_MOVE", {"agent_id": agent_id, "target": f"meeting_{i:02d}"})
        await _pause(6)
        return meeting_id, attendees

    async def kickoff_minutes(self, goal_id: str, title: str, brief: str, criteria: list[str]) -> str:
        """Notulen kickoff deterministik (tanpa LLM): arahan, kriteria selesai, dan pembagian kerja dari DB."""
        who = {a["agent_id"]: f"{a['name']} ({a['role']})" for a in await self.repo.list_agents()}
        rows = "\n".join(f"| {t['title']} | {who.get(t['assigned_to'], t['assigned_to'])} | "
                         f"{who.get(t['reviewer_id'], '-')} |" for t in await self.repo.list_tasks(goal_id))
        done = "\n".join(f"- {c}" for c in criteria) or "- Hasil sesuai permintaan Supervisor dan bisa langsung dicek."
        return (f"# Kickoff: {title}\n\n## Arahan\n\n{brief}\n\n## Kriteria selesai\n\n{done}\n\n"
                f"## Pembagian kerja\n\n| Task | Penanggung jawab | Reviewer |\n|---|---|---|\n{rows}\n")

    async def kickoff_close(self, meeting_id: str, goal_id: str, attendees: list[str], minutes: str | None) -> None:
        """Simpan notulen (None = rapat batal) dan kembalikan peserta ke meja."""
        await self.repo.finish_meeting(meeting_id, minutes or "Kickoff dibatalkan.", "DONE" if minutes else "CANCELLED")
        bus.publish("MEETING_ENDED", {"meeting_id": meeting_id, "type": "KICKOFF", "goal_id": goal_id, "minutes": minutes})
        for agent_id in attendees:
            await self.agent_state(agent_id, "IDLE", emotion_icon=None)
            bus.publish("AGENT_MOVE", {"agent_id": agent_id, "target": (await self.repo.get_agent(agent_id))["desk_id"]})

    async def start_goal(self, goal_id: str) -> None:
        for t in await self.repo.list_tasks(goal_id):
            if t["status"] == "PLANNED":
                await self.repo.update_task(t["task_id"], status="TODO")
                await self.task_event(t["task_id"])
        await self.repo.set_goal(goal_id, "RUNNING")
        bus.publish("GOAL_UPDATED", {"goal_id": goal_id, "status": "RUNNING"})

    async def cancel_goal(self, goal_id: str) -> None:
        for t in await self.repo.list_tasks(goal_id):
            if t["status"] in ("DONE", "FAILED", "CANCELLED"):
                continue
            await self.gate.cancel_for_task(t["task_id"])
            if runner := self.running.pop(t["task_id"], None):
                runner.cancel()
            await self.repo.update_task(t["task_id"], status="CANCELLED", finished_at=_now())
            await self.task_event(t["task_id"])
            await self.agent_state(t["assigned_to"], "IDLE")
        await self.repo.set_goal(goal_id, "CANCELLED")
        bus.publish("GOAL_UPDATED", {"goal_id": goal_id, "status": "CANCELLED"})

    async def _maybe_finish_goal(self, goal_id: str | None) -> None:
        if not goal_id:
            return
        while blocked := await self.repo.blocked_tasks(goal_id):
            for t in blocked:
                await self.repo.update_task(t["task_id"], status="CANCELLED", finished_at=_now(),
                                            error="Dibatalkan: task prasyarat gagal.")
                await self.task_event(t["task_id"])
        tasks = await self.repo.list_tasks(goal_id)
        if all(t["status"] in ("DONE", "FAILED", "CANCELLED") for t in tasks):
            ok = lambda t: t["status"] == "DONE" or (t["epic_key"] == DESIGN_EPIC and t["status"] == "CANCELLED")
            status = "DONE" if all(ok(t) for t in tasks) else "FAILED"
            if not await self.repo.finish_goal_once(goal_id, status):
                return
            bus.publish("GOAL_UPDATED", {"goal_id": goal_id, "status": status})
            await self.on_goal_finished(goal_id, status)

    async def on_goal_finished(self, goal_id: str, status: str) -> None:
        """Laporan hasil ke Supervisor. Orkestrator LLM menimpa: Hanako (indeks folder) & Shiori (ringkasan)."""
        await self.report_to_boss(goal_id, status, None, await self.plain_summary(goal_id, status))

    async def plain_summary(self, goal_id: str, status: str) -> str:
        """Ringkasan deterministik dari data task (tanpa LLM)."""
        tasks = await self.repo.list_tasks(goal_id)
        done = [t for t in tasks if t["status"] == "DONE"]
        failed = [t for t in tasks if t["status"] != "DONE"]
        lines = [f"{len(done)} dari {len(tasks)} task selesai."]
        lines += [f"- Selesai: {t['title']}" for t in done]
        lines += [f"- {t['status']}: {t['title']}" + (f" ({t['error'][:120]})" if t["error"] else "") for t in failed]
        return "\n".join(lines)

    async def report_to_boss(self, goal_id: str, status: str, path: str | None, summary: str) -> None:
        """Simpan laporan, kirim ke klien (modal Laporan Hasil terbuka), dan Ren melapor lisan."""
        await self.repo.set_goal_report(goal_id, path, summary)
        bus.publish("GOAL_UPDATED", {"goal_id": goal_id, "status": status, "report_path": path, "summary": summary})
        if status == "DONE":
            self.say("agent_ren", "Bos, pekerjaannya sudah selesai. Laporan dan hasilnya sudah saya kirim, silakan dicek.",
                     style="anime_command_gold")
            await self.on_preview(goal_id)
            return
        self.say("agent_ren", "Bos, ada yang gagal. Saya siapkan pilihan perbaikannya, Bos tinggal pilih.",
                 style="anime_command_gold")
        await self.save_recovery(goal_id)

    async def on_preview(self, goal_id: str) -> None:
        """Thumbnail hasil untuk kartu proyek (orkestrator LLM membuatnya dari screenshot)."""

    async def save_recovery(self, goal_id: str) -> dict:
        recovery = await self.recommend_fix(goal_id)
        await self.repo.set_goal_recovery(goal_id, recovery)
        bus.publish("GOAL_UPDATED", {"goal_id": goal_id, "recovery_json": json.dumps(recovery, ensure_ascii=False)})
        return recovery

    async def recommend_fix(self, goal_id: str) -> dict:
        """Diagnosis bahasa awam + pilihan perbaikan siap kirim (tanpa LLM). Orkestrator LLM menimpa."""
        goal = await self.repo.get_goal(goal_id)
        errors = " ".join(t["error"] or "" for t in await self.repo.list_tasks(goal_id)) + " " + (goal["summary"] or "")
        return fix_options(goal["prompt"], diagnose(errors), [])

    MEETING_SPEAKERS = ["agent_sora", "agent_maya", "agent_aoi", "agent_luna", "agent_ryota", "agent_daichi"]
    BUSY = ("THINKING", "WORKING", "QUEUED", "WAITING_APPROVAL", "TALKING", "OFFLINE")

    async def speak(self, agent_id: str, instruction: str) -> str:
        """Satu giliran bicara di rapat. DEMO_MODE: kalimat tetap; orkestrator LLM menimpa."""
        return {"agent_ren": "Selamat pagi tim. Mari kita tinjau progres minggu ini.",
                "agent_nana": "Notulen: semua lead memberi update; tidak ada keputusan baru."}.get(
            agent_id, "Divisi kami on track, tidak ada hambatan besar.")

    async def all_hands(self, meeting_id: str) -> None:
        agents = await self.repo.list_agents()
        attending = [a for a in agents if a["status"] not in self.BUSY]
        remote = [a for a in agents if a["status"] in self.BUSY and a["status"] != "OFFLINE"]
        attending, overflow = attending[:50], attending[50:]
        remote += overflow
        slots: dict[str, str] = {}
        n = 0
        for a in attending:
            if a["agent_id"] == "agent_ren":
                slots[a["agent_id"]] = "podium"
            else:
                n += 1
                slots[a["agent_id"]] = f"townhall_{n:02d}"
        await self.repo.create_meeting(meeting_id, "ALL_HANDS", ["Progres goal", "Update divisi", "Hambatan"])
        for a in attending:
            await self.repo.add_participant(meeting_id, a["agent_id"], slots[a["agent_id"]], False)
        for a in remote:
            await self.repo.add_participant(meeting_id, a["agent_id"], None, True)
            bus.publish_agent_state(a["agent_id"], emotion_icon="satellite")
        bus.publish("MEETING_STARTED", {"meeting_id": meeting_id, "type": "ALL_HANDS",
                                        "participants": list(slots), "remote": [a["agent_id"] for a in remote]})
        for agent_id, slot in slots.items():
            await self.repo.set_agent(agent_id, status="MEETING")
            bus.publish_agent_state(agent_id, status="MEETING", emotion_icon=None)
            bus.publish("AGENT_MOVE", {"agent_id": agent_id, "target": slot})
        transcript: list[str] = []
        try:
            await _pause(15)
            progress = await self.repo.progress_summary()
            opening = await self.speak("agent_ren", f"Buka rapat All-Hands. Data progres dari sistem: {progress}")
            transcript.append(f"Ren: {opening}")
            self.say("agent_ren", opening[:140], None, "anime_command_gold")
            for speaker in self.MEETING_SPEAKERS:
                await _pause(4)
                agent = await self.repo.get_agent(speaker)
                activity = await self.repo.recent_activity(agent["division"], speaker, 5)
                facts = "; ".join(f"[{t['status']}] {t['title']}" for t in activity) or "belum ada task"
                line = await self.speak(speaker, f"Beri update divisi {agent['division']} maks 60 kata. Fakta: {facts}")
                transcript.append(f"{agent['name']}: {line}")
                self.say(speaker, line[:140])
            minutes = await self.write_minutes("\n".join(transcript), len(slots), len(remote))
            await self.repo.finish_meeting(meeting_id, minutes)
            await self.on_meeting_minutes(meeting_id, minutes)
            bus.publish("MEETING_ENDED", {"meeting_id": meeting_id, "minutes": minutes})
        except Exception as exc:
            log.exception("All-Hands gagal")
            await self.repo.finish_meeting(meeting_id, f"Rapat dihentikan: {exc}", status="CANCELLED")
            bus.publish("MEETING_ENDED", {"meeting_id": meeting_id, "minutes": None})
        finally:
            await _pause(3)
            for a in attending:
                if (await self.repo.get_agent(a["agent_id"]))["status"] == "MEETING":
                    await self.repo.set_agent(a["agent_id"], status="IDLE")
                    bus.publish_agent_state(a["agent_id"], status="IDLE", emotion_icon=None)
                bus.publish("AGENT_MOVE", {"agent_id": a["agent_id"], "target": a["desk_id"]})
            for a in remote:
                bus.publish_agent_state(a["agent_id"], emotion_icon=None)

    async def write_minutes(self, transcript: str, present: int, remote: int) -> str:
        """Nana menulis notulen. DEMO_MODE: transkrip apa adanya."""
        return f"Peserta: {present} hadir, {remote} remote\n\nTranskrip:\n{transcript}"

    async def on_meeting_minutes(self, meeting_id: str, minutes: str) -> None:
        """Hook: orkestrator LLM menyimpan notulen ke memori (MEETING_MINUTES)."""

    async def chat(self, agent_id: str, message: str) -> None:
        """DEMO_MODE: balasan tetap tanpa LLM."""
        thread = f"chat:{agent_id}"
        await self.repo.add_message(thread, "human", agent_id, "user", message)
        reply = "(DEMO_MODE) Pesan diterima. Aktifkan LLM (DEMO_MODE=0) untuk jawaban sungguhan."
        message_id = await self.repo.add_message(thread, agent_id, "human", "assistant", reply, "whisper_dotted")
        bus.publish("AGENT_CHAT_REPLY", {"agent_id": agent_id, "message_id": message_id, "text": reply, "done": True})
        self.say(agent_id, reply, None, "whisper_dotted")

    async def scheduler_loop(self) -> None:
        while True:
            try:
                free = self.max_active - len(self.running)
                if free > 0:
                    for task in await self.repo.ready_tasks(free):
                        if task["task_id"] not in self.running:
                            self.running[task["task_id"]] = asyncio.create_task(self._run(task))
            except Exception:
                log.exception("scheduler tick failed")
            await asyncio.sleep(1)

    async def _run(self, task: dict) -> None:
        try:
            await self.execute_task(task)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("task %s failed", task["task_id"])
            await self.repo.update_task(task["task_id"], status="FAILED", error=str(exc)[:500], finished_at=_now())
            await self.task_event(task["task_id"])
            await self.agent_state(task["assigned_to"], "ERROR", emotion_icon="sweat")
        finally:
            self.running.pop(task["task_id"], None)
            await self._maybe_finish_goal(task["goal_id"])

    async def execute_task(self, task: dict) -> None:
        task_id, agent = task["task_id"], task["assigned_to"]
        await self.repo.update_task(task_id, status="IN_PROGRESS", started_at=_now())
        await self.task_event(task_id)
        current = {"task_id": task_id, "title": task["title"]}
        if task["reviewer_id"] and task["handoff_line"]:
            self.say(task["reviewer_id"], task["handoff_line"], agent)

        await self.agent_state(agent, "THINKING", emotion_icon="thought", task_id=task_id, current_task=current)
        await _pause(random.uniform(1.5, 3))
        await self.agent_state(agent, "WORKING", emotion_icon=None, task_id=task_id, current_task=current)
        await _pause(random.uniform(3, 6))

        if tool := self.tools.get(task_id):
            c = classify(tool.name, tool.base_risk, tool.args)
            if c.risk is Risk.FORBIDDEN:
                raise RuntimeError(f"FORBIDDEN: {c.reason}")
            if c.risk is Risk.HIGH:
                approved, note, _ = await self._gated(agent, task_id, tool, c.reason)
                if not approved:
                    await self.repo.update_task(task_id, status="FAILED", error=note, finished_at=_now())
                    await self.task_event(task_id)
                    await self.agent_state(agent, "ERROR", emotion_icon="cross")
                    self.say(agent, "…Ditolak. Baiklah.", style="thought_cloud")
                    await _pause(3)
                    await self.agent_state(agent, "IDLE")
                    return
            bus.publish("TOOL_EXECUTION_LOG", {"agent_id": agent, "task_id": task_id, "tool_name": tool.name,
                                               "risk_level": c.risk.value, "status": "SUCCEEDED"})

        await self.repo.update_task(task_id, status="DONE", finished_at=_now(),
                                    result_summary=f"[simulasi] {task['title']} selesai")
        await self.task_event(task_id)
        await self.agent_state(agent, "IDLE", emotion_icon="check")
        self.say(agent, f"Selesai: {task['title']}", task["reviewer_id"])
        await _pause(2)
        await self.agent_state(agent, "IDLE", emotion_icon=None)

    async def _gated(self, agent: str, task_id: str, tool: SimTool, reason: str | None) -> tuple[bool, str, str]:
        """Approval + Goro berjalan ke meja agen peminta (PRD §5.7)."""
        desk = (await self.repo.get_agent(agent))["desk_id"]
        bus.publish("AGENT_MOVE", {"agent_id": "agent_goro", "target": desk})
        try:
            return await self.gate.request(
                agent_id=agent, task_id=task_id, tool_name=tool.name, tool_input=tool.args, reason=reason,
                justification="Deploy versi baru setelah test lulus.")
        finally:
            bus.publish("AGENT_MOVE", {"agent_id": "agent_goro", "target": "desk_ops_08"})
