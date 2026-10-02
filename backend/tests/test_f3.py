"""F3: Masa/Seiji/Zero, All-Hands, Hanako/Shiori: tanpa LLM sungguhan."""
import asyncio

import pytest

from app.config import settings
from app.gate.approval import ApprovalGate
from app.llm.router import LLMRouter
from app.llm_orchestrator import LLMOrchestrator
from app.ops import Ops, host_health
from app.sim import Orchestrator
from app.ws.gateway import bus


def events(since: int) -> list[tuple[str, dict]]:
    import json
    return [(d["event"], d["payload"]) for s, raw in bus.ring if s > since for d in [json.loads(raw)]]


async def _no_pause(_):
    await asyncio.sleep(0)


@pytest.fixture
def router(monkeypatch):
    for k in ("GROQ_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY"):
        monkeypatch.setenv(k, "x")
    return LLMRouter(settings.llm_limits_path)


async def test_masa_quota_alert_edge_triggered_and_throttle(repo, router, tmp_path):
    orch = Orchestrator(repo, ApprovalGate(repo), 6)
    ops = Ops(repo, router, orch, ApprovalGate(repo), str(tmp_path))
    primary = router.chains["T1_REASON"][0]
    router.state[primary].day_key = __import__("time").strftime("%Y-%m-%d", __import__("time").gmtime(__import__("time").time() - 7 * 3600))
    router.state[primary].day_requests = int(router.limits[primary].rpd * 0.9)
    seq = bus.seq
    ops.check_quota()
    ops.check_quota()
    alerts = [p for e, p in events(seq) if e == "SYSTEM_ALERT"]
    assert len(alerts) == 1 and alerts[0]["code"] == "QUOTA_LOW"
    assert orch.max_active == 3
    router.state[primary].day_requests = 0
    ops.check_quota()
    assert orch.max_active == 6 and not any(k.startswith("quota:") for k in ops.alerted)


async def test_seiji_health_and_stuck_task(repo, router, tmp_path):
    h = host_health(str(tmp_path))
    assert set(h) == {"cpu_pct", "ram_pct", "disk_pct"} and 0 <= h["ram_pct"] <= 100
    await repo.create_task({"task_id": "t1", "title": "Lama", "division": "engineering",
                            "assigned_to": "agent_kenji", "created_by": "human", "status": "IN_PROGRESS"})
    await repo.db.execute("UPDATE tasks SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')")
    ops = Ops(repo, router, Orchestrator(repo, ApprovalGate(repo), 6), ApprovalGate(repo), str(tmp_path))
    seq = bus.seq
    await ops.check_health()
    codes = [p["code"] for e, p in events(seq) if e == "SYSTEM_ALERT"]
    assert "TASK_STUCK" in codes


async def test_host_pressure_tidak_spam(repo, router, tmp_path, monkeypatch):
    """CPU yang naik-turun di sekitar ambang 90% hanya menghasilkan satu alert."""
    import app.ops as ops_mod
    ops = Ops(repo, router, Orchestrator(repo, ApprovalGate(repo), 6), ApprovalGate(repo), str(tmp_path))
    seq = bus.seq
    for cpu in (95, 88, 93, 70, 96, 89, 100):
        monkeypatch.setattr(ops_mod, "host_health", lambda _p, c=cpu: {"cpu_pct": c, "ram_pct": 10, "disk_pct": 10})
        await ops.check_health()
    alerts = [p for e, p in events(seq) if e == "SYSTEM_ALERT" and p["code"] == "HOST_PRESSURE"]
    assert len(alerts) == 1


async def test_zero_cleanup_requires_approval(repo, router, tmp_path):
    await repo.db.execute("INSERT INTO llm_usage (agent_id, tier, model, status, created_at) VALUES "
                          "('agent_ren','T1_REASON','m','OK', strftime('%Y-%m-%dT%H:%M:%fZ','now','-200 days'))")
    await repo.db.commit()
    gate = ApprovalGate(repo)
    ops = Ops(repo, router, Orchestrator(repo, gate, 6), gate, str(tmp_path))
    pending = asyncio.create_task(ops.propose_cleanup())
    for _ in range(50):
        if gate._pending:
            break
        await asyncio.sleep(0.01)
    (rid,) = gate._pending
    assert (await repo.get_approval(rid))["tool_name"] == "Cache_Cleaner"
    assert (await repo.cleanup_counts(90, 30))["llm_usage"] == 1
    await gate.resolve(rid, True, None)
    assert await pending is True
    assert (await repo.cleanup_counts(90, 30))["llm_usage"] == 0
    assert await ops.propose_cleanup() is None


async def test_all_hands_moves_speaks_and_restores(repo, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = Orchestrator(repo, ApprovalGate(repo), 6)
    await repo.set_agent("agent_kenji", status="WORKING")
    seq = bus.seq
    await orch.all_hands("mtg_1")
    ev = events(seq)
    started = next(p for e, p in ev if e == "MEETING_STARTED")
    assert "agent_kenji" in started["remote"] and "agent_kenji" not in started["participants"]
    targets = [p["target"] for e, p in ev if e == "AGENT_MOVE"]
    assert "podium" in targets and "townhall_01" in targets
    speakers = [p["speaker_id"] for e, p in ev if e == "AGENT_DIALOGUE_SPOKEN"]
    assert speakers[0] == "agent_ren" and set(orch.MEETING_SPEAKERS) <= set(speakers)
    meeting = (await repo.list_meetings())[0]
    assert meeting["status"] == "DONE" and meeting["minutes"]
    assert (await repo.get_agent("agent_sora"))["status"] == "IDLE"
    assert (await repo.get_agent("agent_kenji"))["status"] == "WORKING"


async def test_goal_finish_once_with_hanako_and_shiori(repo, tmp_path):
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        return "```markdown\nRingkasan: modul selesai.\n```", None

    orch.run_agent = fake
    await repo.create_goal("goal_1", "Bangun modul", 2, False)
    await repo.set_goal("goal_1", "RUNNING")
    await repo.create_task({"task_id": "t1", "goal_id": "goal_1", "title": "A", "division": "engineering",
                            "assigned_to": "agent_kenji", "created_by": "human", "status": "DONE"})
    ws = tmp_path / "ws" / "goal_1"
    (ws / "reports").mkdir(parents=True)
    (ws / "reports" / "E1_kenji.md").write_text("# A\nselesai")
    (ws / "mod.py").write_text("x = 1")
    await asyncio.gather(orch._maybe_finish_goal("goal_1"), orch._maybe_finish_goal("goal_1"))
    assert "mod.py" in (ws / "INDEX.md").read_text()
    report = (ws / "REPORT-goal_1.md").read_text()
    assert "Ringkasan: modul selesai." in report and "selesai" in report
    goal = await repo.get_goal("goal_1")
    assert goal["report_path"] == "REPORT-goal_1.md" and goal["summary"] == "Ringkasan: modul selesai."
    from app.llm_orchestrator import deliverable_files
    assert deliverable_files(ws) == ["mod.py"]


async def test_demo_goal_reports_to_boss(repo):
    """Tanpa LLM pun bos tetap menerima laporan: ringkasan dari data task + ucapan Ren."""
    orch = Orchestrator(repo, ApprovalGate(repo), 6)
    await repo.create_goal("goal_1", "Bangun modul", 2, False)
    await repo.set_goal("goal_1", "RUNNING")
    for tid, status in (("t1", "DONE"), ("t2", "FAILED")):
        await repo.create_task({"task_id": tid, "goal_id": "goal_1", "title": f"Task {tid}", "division": "engineering",
                                "assigned_to": "agent_kenji", "created_by": "human", "status": status})
    seq = bus.seq
    await orch._maybe_finish_goal("goal_1")
    ev = events(seq)
    report = [p for e, p in ev if e == "GOAL_UPDATED" and p.get("summary")][0]
    assert report["status"] == "FAILED" and "1 dari 2 task selesai" in report["summary"]
    assert (await repo.get_goal("goal_1"))["summary"] == report["summary"]
    assert any(e == "AGENT_DIALOGUE_SPOKEN" and p["speaker_id"] == "agent_ren" for e, p in ev)


def test_no_emdash_in_agent_speech(repo):
    from app.sim import no_emdash
    assert no_emdash("Sudah beres — tinggal dicek.") == "Sudah beres, tinggal dicek."
    assert no_emdash("butuh 2–3 hari") == "butuh 2-3 hari"
    orch = Orchestrator(repo, ApprovalGate(repo), 6)
    seq = bus.seq
    orch.say("agent_ren", "Sora — **tolong** cek ya")
    text = [p["text"] for e, p in events(seq) if e == "AGENT_DIALOGUE_SPOKEN"][0]
    assert text == "Sora, tolong cek ya"
