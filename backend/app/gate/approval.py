import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

from ulid import ULID

from app.ws.gateway import bus

WORKSPACE = Path("/workspace").resolve()
APPROVAL_TIMEOUT_S = 600


class Risk(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    FORBIDDEN = "FORBIDDEN"


_ORDER = [Risk.LOW, Risk.MEDIUM, Risk.HIGH, Risk.FORBIDDEN]
_SQL_WRITE = re.compile(r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|PRAGMA|REPLACE|CREATE)\b", re.I)
_SHELL_FORBIDDEN = re.compile(r"rm\s+-rf\s+/(\s|$)|mkfs|\bdd\s+if=|:\(\)\s*\{|(curl|wget)[^|]*\|\s*(ba)?sh")
_SECRET_PATH = re.compile(r"(^|/)(\.env|id_rsa[^/]*|[^/]+\.pem|\.git/config)$")
_PRIVATE_HOST = re.compile(r"^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)")


@dataclass
class Classification:
    risk: Risk
    reason: str | None = None


def _raise(current: Classification, risk: Risk, reason: str) -> Classification:
    """Level risiko hanya boleh naik, tidak pernah turun. Alasan pertama untuk level yang sama dipertahankan."""
    if _ORDER.index(risk) > _ORDER.index(current.risk) or (risk is current.risk and current.reason is None):
        return Classification(risk, reason)
    return current


def classify(tool_name: str, base: Risk, args: dict) -> Classification:
    c = Classification(base)
    if "sql" in args and _SQL_WRITE.search(str(args["sql"])):
        c = _raise(c, Risk.HIGH, "SQL mengubah data/skema")
    if "path" in args:
        p = (WORKSPACE / str(args["path"])).resolve()
        if not p.is_relative_to(WORKSPACE):
            c = _raise(c, Risk.FORBIDDEN, "Path di luar /workspace")
        elif _SECRET_PATH.search(p.as_posix()):
            c = _raise(c, Risk.FORBIDDEN, "Path file rahasia")
    if "method" in args and str(args["method"]).upper() not in ("GET", "HEAD"):
        c = _raise(c, Risk.HIGH, f"HTTP {str(args['method']).upper()}")
    if "url" in args:
        host = re.sub(r"^https?://", "", str(args["url"])).split("/")[0]
        if _PRIVATE_HOST.match(host):
            c = _raise(c, Risk.FORBIDDEN, "Tujuan jaringan privat/metadata")
    if "command" in args:
        if _SHELL_FORBIDDEN.search(str(args["command"])):
            c = _raise(c, Risk.FORBIDDEN, "Perintah destruktif")
        else:
            c = _raise(c, Risk.HIGH, "Eksekusi perintah shell")
    return c


class ApprovalGate:
    def __init__(self, repo) -> None:
        self.repo = repo
        self._pending: dict[str, asyncio.Future[tuple[bool, str | None]]] = {}

    async def request(self, *, agent_id: str, task_id: str | None, tool_name: str,
                      tool_input: dict, reason: str | None, justification: str | None) -> tuple[bool, str, str]:
        """Bekukan agen sampai Supervisor memutuskan. Return (approved, pesan untuk agen, request_id)."""
        timeout_s = APPROVAL_TIMEOUT_S
        request_id = f"req_{ULID()}"
        expires = datetime.now(timezone.utc) + timedelta(seconds=timeout_s)
        fut: asyncio.Future[tuple[bool, str | None]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = fut
        await self.repo.insert_approval(request_id=request_id, task_id=task_id, agent_id=agent_id,
                                        tool_name=tool_name, tool_input=json.dumps(tool_input),
                                        escalation_reason=reason, justification=justification,
                                        expires_at=expires.isoformat())
        await self.repo.set_task_status(task_id, "WAITING_APPROVAL")
        await self.repo.set_agent(agent_id, status="WAITING_APPROVAL", emotion_icon="hourglass")
        bus.publish_agent_state(agent_id, status="WAITING_APPROVAL", animation="Idle_Frozen",
                                emotion_icon="hourglass")
        bus.publish("APPROVAL_REQUIRED", {
            "request_id": request_id, "agent_id": agent_id, "task_id": task_id,
            "tool_name": tool_name, "tool_input": tool_input, "risk_level": "HIGH",
            "escalation_reason": reason, "justification": justification,
            "expires_at": expires.isoformat(),
        })
        try:
            approved, note = await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            await self.repo.decide_approval(request_id, "EXPIRED", decided_by="system", reason=None)
            bus.publish("APPROVAL_RESOLVED", {"request_id": request_id, "status": "EXPIRED"})
            approved, note = False, "EXPIRED: tidak ada keputusan sampai batas waktu"
        finally:
            self._pending.pop(request_id, None)
        await self.repo.set_task_status(task_id, "IN_PROGRESS")
        await self.repo.set_agent(agent_id, status="WORKING", emotion_icon=None)
        bus.publish_agent_state(agent_id, status="WORKING", emotion_icon="check" if approved else "cross")
        return approved, note or ("APPROVED" if approved else "REJECTED"), request_id

    async def resolve(self, request_id: str, approve: bool, reason: str | None) -> bool:
        """Dipanggil handler USER_APPROVAL_RESPONSE. False jika request tidak lagi pending."""
        fut = self._pending.get(request_id)
        if fut is None or fut.done():
            return False
        status = "APPROVED" if approve else "REJECTED"
        await self.repo.decide_approval(request_id, status, decided_by="human", reason=reason)
        bus.publish("APPROVAL_RESOLVED", {"request_id": request_id, "status": status, "reason": reason})
        fut.set_result((approve, None if approve else f"REJECTED: {reason or 'tanpa alasan'}"))
        return True

    async def cancel_for_task(self, task_id: str) -> None:
        for request_id, fut in list(self._pending.items()):
            if not fut.done() and await self.repo.approval_task_id(request_id) == task_id:
                await self.repo.decide_approval(request_id, "CANCELLED", decided_by="system", reason=None)
                fut.set_result((False, "CANCELLED: task dibatalkan"))
