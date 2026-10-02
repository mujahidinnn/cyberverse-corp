"""Alur goal penuh di DB nyata: plan → scheduler → approval Hiro → DONE (TS-01, TS-12)."""
import asyncio

from app.gate.approval import ApprovalGate
from app.sim import Orchestrator


async def _no_pause(_):
    await asyncio.sleep(0)


async def _wait(cond, timeout=10):
    for _ in range(int(timeout / 0.05)):
        if await cond():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("timeout")


async def test_goal_flow_with_approval(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    gate = ApprovalGate(repo)
    orch = Orchestrator(repo, gate, max_active=6)
    goal = await repo.create_goal("goal_1", "Bangun API todo list", 2, False)
    await orch.plan_goal(goal["goal_id"])
    loop = asyncio.create_task(orch.scheduler_loop())

    async def approval_pending():
        tasks = await repo.list_tasks("goal_1")
        return bool(gate._pending) and any(t["status"] == "WAITING_APPROVAL" for t in tasks)
    await _wait(approval_pending)

    tasks = {t["title"]: t for t in await repo.list_tasks("goal_1")}
    deploy = tasks["Deploy ke VPS"]
    assert deploy["status"] == "WAITING_APPROVAL"
    assert tasks["Jalankan test suite"]["status"] == "DONE"
    assert (await repo.get_agent("agent_hiro"))["status"] == "WAITING_APPROVAL"

    (rid,) = gate._pending
    await gate.resolve(rid, True, None)

    async def goal_done():
        return (await repo.get_goal("goal_1"))["status"] == "DONE"
    await _wait(goal_done)
    assert (await repo.get_approval(rid))["status"] == "APPROVED"
    loop.cancel()
