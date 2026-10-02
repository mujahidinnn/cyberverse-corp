import asyncio
import json
import logging
import base64
import re
import secrets
import shutil
import time
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field, ValidationError
from ulid import ULID

from app.config import settings
from app.db.repo import Repo
from app.gate.approval import ApprovalGate
from app.llm.router import LLMRouter
from app.llm_orchestrator import LLMOrchestrator, company_profile, deliverable_files, load_profiles
from app.ops import Ops, quota_view
from app.memory import Memory
from app.sim import Orchestrator
from app.ws.events import ClientEvent
from app.ws.gateway import Client, bus

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cyberverse")


class State:
    repo: Repo
    gate: ApprovalGate
    router: LLMRouter
    orch: Orchestrator
    ops: Ops
    profiles: dict


state = State()


@asynccontextmanager
async def lifespan(_: FastAPI):
    state.repo = await Repo.open(settings.database_path)
    state.gate = ApprovalGate(state.repo)
    state.router = LLMRouter(settings.llm_limits_path)
    state.orch = (Orchestrator(state.repo, state.gate, settings.max_active_agents) if settings.demo_mode else
                  LLMOrchestrator(state.repo, state.gate, settings.max_active_agents, state.router,
                                  settings.workspace_path, settings.agents_path, Memory(settings.chroma_path)))
    state.profiles = getattr(state.orch, "profiles", None) or load_profiles(settings.agents_path)
    state.profiles.update(await state.repo.hired_profiles())
    state.ops = Ops(state.repo, state.router, state.orch, state.gate, settings.workspace_path)
    Path(settings.workspace_path).mkdir(parents=True, exist_ok=True)
    bus.sink = lambda event, ts, payload: asyncio.create_task(state.repo.log_event(event, ts, payload))
    daemons = asyncio.create_task(state.ops.run())
    scheduler = asyncio.create_task(state.orch.scheduler_loop())
    if getattr(state.orch, "memory", None):
        asyncio.create_task(state.orch.memory.warmup())
    log.info("CyberVerse backend ready (demo_mode=%s, models=%s)", settings.demo_mode, list(state.router.limits))
    yield
    bus.sink = None
    scheduler.cancel()
    daemons.cancel()
    await state.repo.close()


app = FastAPI(title="CyberVerse Corp Backend", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.frontend_origins,
                   allow_methods=["*"], allow_headers=["*"])


def require_token(authorization: str = Header(default="")) -> None:
    if not secrets.compare_digest(authorization, f"Bearer {settings.supervisor_token}"):
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Token tidak valid"})


@app.get("/api/v1/health")
async def health() -> dict:
    return {"status": "ok", "version": app.version, "demo_mode": settings.demo_mode}


async def build_snapshot() -> dict:
    return {
        "agents": [a | {k: state.profiles.get(a["agent_id"], {}).get(k, d)
                        for k, d in (("ambient_lines", []), ("job", ""), ("skills", []), ("archetype", ""))}
                   for a in await state.repo.list_agents()],
        "tasks": await state.repo.list_tasks(),
        "goals": await state.repo.list_goals(),
        "approvals_pending": [
            {**a, "tool_input": json.loads(a["tool_input"])} for a in await state.repo.list_approvals("PENDING")
        ],
        "quota": {"models": quota_view(state.router.snapshot())},
        "health": state.ops.last_health,
        "meeting": await state.repo.running_meeting(),
    }


@app.get("/api/v1/snapshot", dependencies=[Depends(require_token)])
async def snapshot() -> dict:
    return {"seq": bus.seq, **await build_snapshot()}


@app.get("/api/v1/agents", dependencies=[Depends(require_token)])
async def agents() -> list[dict]:
    return await state.repo.list_agents()


ATTACHMENT_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".txt", ".md", ".html", ".css", ".json", ".csv"}
MAX_ATTACHMENT_BYTES = 4_000_000


class Attachment(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    data: str = Field(max_length=6_000_000)


class GoalIn(BaseModel):
    prompt: str = Field(min_length=10, max_length=4000)
    review_before_run: bool = False
    priority: int = Field(default=2, ge=0, le=3)
    parent_goal_id: str | None = None
    attachments: list[Attachment] = Field(default=[], max_length=6)


def read_attachments(attachments: list[Attachment]) -> list[tuple[str, bytes]]:
    """Validasi semua lampiran dulu (nama aman, tipe, ukuran) sebelum ada yang ditulis."""
    files = []
    for a in attachments:
        name = re.sub(r"[^\w.-]+", "_", Path(a.name).name).strip("._")[:80] or "lampiran"
        if Path(name).suffix.lower() not in ATTACHMENT_TYPES:
            raise HTTPException(415, detail={"code": "UNSUPPORTED_FILE", "message": f"{a.name}: tipe file tidak didukung"})
        try:
            data = base64.b64decode(a.data, validate=True)
        except ValueError:
            raise HTTPException(400, detail={"code": "BAD_FILE", "message": a.name}) from None
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, detail={"code": "FILE_TOO_LARGE", "message": f"{a.name}: maksimal 4 MB"})
        files.append((name, data))
    return files


SKIP_ON_CONTINUE = shutil.ignore_patterns("reports", "REPORT-*", "INDEX.md", "__pycache__", ".pytest_cache")


async def create_goal(body: GoalIn) -> dict:
    parent = body.parent_goal_id and await state.repo.get_goal(body.parent_goal_id)
    if body.parent_goal_id and (not parent or parent["deleted_at"]):
        raise HTTPException(404, detail={"code": "GOAL_NOT_FOUND", "message": body.parent_goal_id})
    if parent and parent["status"] != "DONE":
        raise HTTPException(409, detail={"code": "PARENT_NOT_DONE", "message": "Hanya proyek yang selesai bisa dilanjutkan"})
    files = read_attachments(body.attachments)
    goal = await state.repo.create_goal(f"goal_{ULID()}", body.prompt, body.priority, body.review_before_run,
                                        body.parent_goal_id)
    workspace = Path(settings.workspace_path) / goal["goal_id"]
    if parent and (workspace.parent / parent["goal_id"]).is_dir():
        shutil.copytree(workspace.parent / parent["goal_id"], workspace, ignore=SKIP_ON_CONTINUE, dirs_exist_ok=True)
    for name, data in files:
        (workspace / "references").mkdir(parents=True, exist_ok=True)
        (workspace / "references" / name).write_bytes(data)
    bus.publish("GOAL_UPDATED", {"goal_id": goal["goal_id"], "status": goal["status"], "prompt": goal["prompt"],
                                 "parent_goal_id": goal["parent_goal_id"], "priority": goal["priority"]})
    asyncio.create_task(state.orch.plan_goal(goal["goal_id"]))
    return goal


@app.post("/api/v1/goals", status_code=201, dependencies=[Depends(require_token)])
async def post_goal(body: GoalIn) -> dict:
    return await create_goal(body)


@app.get("/api/v1/goals", dependencies=[Depends(require_token)])
async def list_goals() -> list[dict]:
    return await state.repo.list_goals()


@app.post("/api/v1/goals/{goal_id}/recovery", dependencies=[Depends(require_token)])
async def goal_recovery(goal_id: str) -> dict:
    """Buat (ulang) rekomendasi perbaikan untuk proyek yang gagal."""
    goal = await state.repo.get_goal(goal_id)
    if goal is None or goal["deleted_at"]:
        raise HTTPException(404, detail={"code": "GOAL_NOT_FOUND", "message": goal_id})
    if goal["status"] != "FAILED":
        raise HTTPException(409, detail={"code": "NOT_FAILED", "message": goal["status"]})
    return await state.orch.save_recovery(goal_id)


@app.delete("/api/v1/goals/{goal_id}", status_code=204, dependencies=[Depends(require_token)])
async def delete_goal(goal_id: str) -> None:
    """Hapus proyek yang sudah selesai: hilang dari papan, file hasil dan memorinya dihapus."""
    goal = await state.repo.get_goal(goal_id)
    if goal is None or goal["deleted_at"]:
        raise HTTPException(404, detail={"code": "GOAL_NOT_FOUND", "message": goal_id})
    if goal["status"] not in ("DONE", "FAILED", "CANCELLED"):
        raise HTTPException(409, detail={"code": "GOAL_RUNNING", "message": "Batalkan dulu proyek yang masih berjalan"})
    if await state.repo.has_live_children(goal_id):
        raise HTTPException(409, detail={"code": "HAS_CONTINUATION", "message": "Hapus dulu versi lanjutannya"})
    await state.repo.delete_goal(goal_id)
    shutil.rmtree(Path(settings.workspace_path) / goal_id, ignore_errors=True)
    if memory := getattr(state.orch, "memory", None):
        await memory.forget_goal(goal_id)
    bus.publish("GOAL_DELETED", {"goal_id": goal_id})


@app.post("/api/v1/goals/{goal_id}/{command}", dependencies=[Depends(require_token)])
async def goal_command(goal_id: str, command: Literal["start", "cancel"]) -> dict:
    goal = await state.repo.get_goal(goal_id)
    if goal is None:
        raise HTTPException(404, detail={"code": "GOAL_NOT_FOUND", "message": goal_id})
    if command == "start" and goal["status"] == "AWAITING_START":
        await state.orch.start_goal(goal_id)
    elif command == "cancel" and goal["status"] not in ("DONE", "FAILED", "CANCELLED"):
        await state.orch.cancel_goal(goal_id)
    else:
        raise HTTPException(409, detail={"code": "INVALID_STATE", "message": goal["status"]})
    return await state.repo.get_goal(goal_id)


@app.get("/api/v1/tasks", dependencies=[Depends(require_token)])
async def list_tasks(goal_id: str | None = None) -> list[dict]:
    return await state.repo.list_tasks(goal_id)


@app.get("/api/v1/approvals", dependencies=[Depends(require_token)])
async def list_approvals(status: str | None = None) -> list[dict]:
    return await state.repo.list_approvals(status)


class DecisionIn(BaseModel):
    decision: Literal["APPROVE", "REJECT"]
    reason: str | None = Field(default=None, max_length=500)


@app.post("/api/v1/approvals/{request_id}/decision", dependencies=[Depends(require_token)])
async def decide(request_id: str, body: DecisionIn) -> dict:
    if not await state.gate.resolve(request_id, body.decision == "APPROVE", body.reason):
        raise HTTPException(409, detail={"code": "NOT_PENDING", "message": "Approval sudah final atau tidak ada"})
    return await state.repo.get_approval(request_id)


@app.get("/api/v1/agents/{agent_id}/messages", dependencies=[Depends(require_token)])
async def agent_messages(agent_id: str, limit: int = 30) -> list[dict]:
    return await state.repo.recent_messages(f"chat:{agent_id}", min(limit, 100))


class TaskIn(BaseModel):
    title: str = Field(min_length=3, max_length=100)
    description: str = Field(default="", max_length=4000)
    assigned_to: str
    priority: int = Field(default=2, ge=0, le=3)


@app.post("/api/v1/tasks", status_code=201, dependencies=[Depends(require_token)])
async def create_task(body: TaskIn) -> dict:
    agent = await state.repo.get_agent(body.assigned_to)
    if agent is None or agent["kind"] != "llm":
        raise HTTPException(422, detail={"code": "INVALID_ASSIGNEE", "message": body.assigned_to})
    task = await state.repo.create_task({
        "task_id": f"task_{ULID()}", "goal_id": None, "title": body.title, "description": body.description,
        "division": agent["division"], "assigned_to": body.assigned_to, "created_by": "human",
        "status": "TODO", "priority": body.priority,
        "acceptance_json": json.dumps(["Sesuai permintaan Supervisor"], ensure_ascii=False),
    })
    bus.publish("TASK_CREATED", task)
    return task


class RuleIn(BaseModel):
    content: str = Field(min_length=3, max_length=500)
    division: Literal["global", "executive", "engineering", "creative", "marketing", "operations"] = "global"


@app.get("/api/v1/rules", dependencies=[Depends(require_token)])
async def list_rules() -> list[dict]:
    return await state.repo.list_rules()


@app.post("/api/v1/rules", status_code=201, dependencies=[Depends(require_token)])
async def add_rule(body: RuleIn) -> dict:
    return await state.repo.add_rule(body.content, body.division)


@app.delete("/api/v1/rules/{rule_id}", status_code=204, dependencies=[Depends(require_token)])
async def delete_rule(rule_id: int) -> None:
    if not await state.repo.deactivate_rule(rule_id):
        raise HTTPException(404, detail={"code": "RULE_NOT_FOUND", "message": str(rule_id)})


async def start_meeting() -> dict:
    if await state.repo.running_meeting():
        raise HTTPException(409, detail={"code": "MEETING_RUNNING", "message": "Rapat sedang berlangsung"})
    meeting_id = f"mtg_{ULID()}"
    asyncio.create_task(state.orch.all_hands(meeting_id))
    return {"meeting_id": meeting_id, "type": "ALL_HANDS"}


@app.post("/api/v1/meetings", status_code=202, dependencies=[Depends(require_token)])
async def post_meeting() -> dict:
    return await start_meeting()


@app.get("/api/v1/meetings", dependencies=[Depends(require_token)])
async def list_meetings() -> list[dict]:
    return await state.repo.list_meetings()


@app.delete("/api/v1/meetings/{meeting_id}", status_code=204, dependencies=[Depends(require_token)])
async def delete_meeting(meeting_id: str) -> None:
    """Hapus rapat beserta notulennya (juga dari memori agen)."""
    meeting = await state.repo.get_meeting(meeting_id)
    if meeting is None:
        raise HTTPException(404, detail={"code": "MEETING_NOT_FOUND", "message": meeting_id})
    if meeting["status"] == "RUNNING":
        raise HTTPException(409, detail={"code": "MEETING_RUNNING", "message": "Rapat masih berlangsung"})
    await state.repo.delete_meeting(meeting_id)
    if memory := getattr(state.orch, "memory", None):
        await memory.forget_doc(meeting_id, "MEETING_MINUTES")
    bus.publish("MEETING_DELETED", {"meeting_id": meeting_id})


@app.delete("/api/v1/agents/{agent_id}/messages", status_code=204, dependencies=[Depends(require_token)])
async def clear_chat(agent_id: str) -> None:
    """Hapus riwayat chat Supervisor dengan satu agen."""
    await state.repo.clear_chat(agent_id)


@app.delete("/api/v1/events", status_code=204, dependencies=[Depends(require_token)])
async def clear_events() -> None:
    """Kosongkan riwayat Log Live."""
    await state.repo.clear_events()


@app.delete("/api/v1/agents/{agent_id}", status_code=204, dependencies=[Depends(require_token)])
async def fire_agent(agent_id: str) -> None:
    """Berhentikan karyawan hasil rekrutmen HRD. Karyawan tetap (agents.yaml) tidak bisa diberhentikan."""
    agent = await state.repo.get_agent(agent_id)
    if agent is None or agent["fired_at"]:
        raise HTTPException(404, detail={"code": "AGENT_NOT_FOUND", "message": agent_id})
    profile = state.profiles.get(agent_id)
    if agent_id not in await state.repo.hired_profiles():
        raise HTTPException(403, detail={"code": "PERMANENT_STAFF", "message": "Karyawan tetap tidak bisa diberhentikan"})
    if await state.repo.open_task_count(agent_id):
        raise HTTPException(409, detail={"code": "HAS_OPEN_TASKS", "message": "Masih ada task yang belum selesai"})
    await state.repo.fire_agent(agent_id)
    if profile:
        profile["fired"] = True
    bus.publish("AGENT_FIRED", {"agent_id": agent_id, "name": agent["name"], "role": agent["role"]})


@app.get("/api/v1/company", dependencies=[Depends(require_token)])
async def company() -> PlainTextResponse:
    """Profil perusahaan (config/company.md) dalam Markdown."""
    return PlainTextResponse(company_profile(settings.agents_path))


@app.get("/api/v1/goals/{goal_id}/report", dependencies=[Depends(require_token)])
async def goal_report(goal_id: str) -> dict:
    """Laporan hasil untuk Supervisor: ringkasan, statistik, daftar task, dan file hasil sebagai lampiran."""
    goal = await state.repo.get_goal(goal_id)
    if goal is None or goal["deleted_at"]:
        raise HTTPException(404, detail={"code": "GOAL_NOT_FOUND", "message": goal_id})
    tasks = await state.repo.list_tasks(goal_id)
    root = Path(settings.workspace_path) / goal_id
    return {
        "goal_id": goal_id, "prompt": goal["prompt"], "status": goal["status"], "summary": goal["summary"],
        "kickoff": await state.repo.goal_kickoff(goal_id),
        "report_path": goal["report_path"], "created_at": goal["created_at"], "finished_at": goal["finished_at"],
        "files": [{"path": f, "size": (root / f).stat().st_size} for f in deliverable_files(root)],
        "tasks": [{"title": t["title"], "assigned_to": t["assigned_to"], "status": t["status"], "epic_key": t["epic_key"],
                   "iteration": t["iteration"], "output_ref": t["output_ref"], "error": t["error"]} for t in tasks],
    }


@app.get("/api/v1/goals/{goal_id}/preview", dependencies=[Depends(require_token)])
async def goal_preview(goal_id: str) -> FileResponse:
    """Screenshot hasil proyek yang berhasil (dibuat sekali, lalu disimpan)."""
    goal = await state.repo.get_goal(goal_id)
    if goal is None or goal["deleted_at"] or goal["status"] != "DONE":
        raise HTTPException(404, detail={"code": "NO_PREVIEW", "message": goal_id})
    from app import vision
    path = await vision.make_preview(Path(settings.workspace_path) / goal_id)
    if path is None:
        raise HTTPException(404, detail={"code": "NO_PREVIEW", "message": "Tidak ada halaman HTML untuk dipotret"})
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/v1/artifacts/{goal_id}/{path:path}", dependencies=[Depends(require_token)])
async def artifact(goal_id: str, path: str) -> PlainTextResponse:
    """Baca file teks hasil kerja agen (read-only). Path dinormalisasi agar tidak keluar workspace goal."""
    root = Path(settings.workspace_path).resolve()
    target = (root / goal_id / path).resolve()
    if not target.is_relative_to(root / goal_id) or not target.is_file():
        raise HTTPException(404, detail={"code": "ARTIFACT_NOT_FOUND", "message": path})
    if target.stat().st_size > 2_000_000:
        raise HTTPException(413, detail={"code": "TOO_LARGE", "message": path})
    return PlainTextResponse(target.read_text(errors="replace"))


@app.get("/api/v1/events", dependencies=[Depends(require_token)])
async def events(limit: int = Query(default=300, ge=1, le=1000)) -> list[dict]:
    """Riwayat kejadian untuk Log Live (urut lama ke baru)."""
    return await state.repo.recent_events(limit)


@app.get("/api/v1/quota", dependencies=[Depends(require_token)])
async def quota() -> dict:
    return {"models": quota_view(state.router.snapshot())}


def _msg(event: str, payload: dict, seq: int | None = None) -> str:
    body = {"v": 1, "event": event, "payload": payload}
    if seq is not None:
        body["seq"] = seq
    return json.dumps(body, ensure_ascii=False, default=str)


async def handle_client_event(event, client: Client) -> None:
    p = event.payload
    match event.event:
        case "PING":
            client.queue.put_nowait(_msg("PONG", {"client_ts": p.client_ts, "server_ts": int(time.time() * 1000)}))
        case "REQUEST_RESYNC":
            missed = bus.replay_since(p.last_seq)
            if missed is None:
                client.queue.put_nowait(_msg("SNAPSHOT", await build_snapshot(), seq=bus.seq))
            else:
                for data in missed:
                    client.queue.put_nowait(data)
        case "USER_INJECT_GOAL":
            try:
                await create_goal(GoalIn(**p.model_dump()))
            except HTTPException as exc:
                client.queue.put_nowait(_msg("ERROR", exc.detail))
        case "USER_APPROVAL_RESPONSE":
            if not await state.gate.resolve(p.request_id, p.decision == "APPROVE", p.reason):
                client.queue.put_nowait(_msg("ERROR", {"code": "NOT_PENDING", "message": p.request_id}))
        case "USER_CHAT_TO_AGENT":
            now = time.monotonic()
            if now - client.last_chat < 3:
                client.queue.put_nowait(_msg("ERROR", {"code": "RATE_LIMITED", "message": "Maks 1 pesan / 3 detik"}))
                return
            client.last_chat = now
            agent = await state.repo.get_agent(p.agent_id)
            if agent is None or agent["kind"] != "llm":
                client.queue.put_nowait(_msg("ERROR", {"code": "INVALID_AGENT", "message": p.agent_id}))
                return
            asyncio.create_task(state.orch.chat(p.agent_id, p.message))
        case "USER_START_MEETING":
            try:
                await start_meeting()
            except HTTPException as exc:
                client.queue.put_nowait(_msg("ERROR", exc.detail))
        case "USER_GOAL_COMMAND":
            try:
                await goal_command(p.goal_id, p.command.lower())
            except HTTPException as exc:
                client.queue.put_nowait(_msg("ERROR", exc.detail))


@app.websocket("/ws/office")
async def office_ws(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if origin and origin not in settings.frontend_origins:
        await ws.close(code=4403)
        return
    await ws.accept()
    try:
        first = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=5))
    except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect):
        await ws.close(code=4408)
        return
    payload = first.get("payload") or {}
    if first.get("event") != "AUTH" or not secrets.compare_digest(
        str(payload.get("token", "")), settings.supervisor_token
    ):
        await ws.close(code=4401)
        return

    client = Client(ws)
    last_seq = payload.get("last_seq")
    missed = bus.replay_since(last_seq) if isinstance(last_seq, int) else None
    await ws.send_text(_msg("HELLO", {"server_seq": bus.seq, "resumed": missed is not None, "protocol_version": 1}))
    if missed is None:
        await ws.send_text(_msg("SNAPSHOT", await build_snapshot(), seq=bus.seq))
    else:
        for data in missed:
            await ws.send_text(data)
    bus.add(client)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                event = ClientEvent.validate_json(raw)
            except ValidationError as exc:
                client.queue.put_nowait(_msg("ERROR", {"code": "INVALID_EVENT", "message": str(exc)[:500]}))
                continue
            await handle_client_event(event, client)
    except WebSocketDisconnect:
        pass
    finally:
        bus.remove(client)
