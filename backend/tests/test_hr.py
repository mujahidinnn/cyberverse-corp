"""Rekrutmen: kebijakan HRD deterministik, alur rekrut di planning, dan migrasi batas nomor agen."""
import asyncio
import sqlite3
from pathlib import Path

from app import hr
from app.config import settings
from app.db.repo import Repo
from app.gate.approval import ApprovalGate
from app.llm.router import LLMRouter
from app.llm_orchestrator import Epic, LLMOrchestrator, Roadmap, TaskBreakdown, TaskSpec, load_profiles
from app.ws.gateway import bus

PROFILES = load_profiles(settings.agents_path)


async def _no_pause(_):
    return None


def ruling(missing, **kw):
    return hr.decide(missing, PROFILES, **({"has_desk": True, "hires_total": 0, "hires_this_goal": 0} | kw))


def test_policy_not_every_request_is_granted():
    assert ruling(["rust", "webassembly"]).decision is hr.Decision.HIRE
    borrow = ruling(["copywriting"])
    assert borrow.decision is hr.Decision.BORROW and borrow.borrow_id == "agent_kaito"
    assert ruling(["rust"], has_desk=False).decision is hr.Decision.REJECT
    assert ruling(["rust"], hires_total=hr.MAX_HIRES).decision is hr.Decision.REJECT
    assert ruling(["rust"], hires_this_goal=1).decision is hr.Decision.ASK_BOSS
    assert ruling(["rust"], hires_total=hr.ASK_AFTER).decision is hr.Decision.ASK_BOSS
    assert ruling(["rust", "copywriting", "kotlin"]).decision is hr.Decision.ASK_BOSS
    assert ruling(["html", "landing_page"]).borrow_id == "agent_momo"
    assert ruling([]).decision is hr.Decision.REJECT


def _orch(repo, tmp_path, missing):
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is Roadmap:
            return "", Roadmap(goal_summary="Modul Rust", brief="Satu modul saja", epics=[
                Epic(key="E1", title="Build", division="engineering", objective="o", success_criteria=["c"])])
        return "", TaskBreakdown(tasks=[TaskSpec(
            key="T1", title="Tulis modul", description="d", required_skills=["python"], acceptance_criteria=["ok"],
            handoff_line="Ayo", missing_skills=missing, new_role="Rust Engineer")])

    orch.run_agent = fake
    return orch


async def test_hrd_hires_when_skill_is_new(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = _orch(repo, tmp_path, ["rust", "webassembly"])
    await repo.create_goal("goal_1", "Bangun modul Rust", 2, False)
    seq = bus.seq
    await orch.plan_goal("goal_1")

    task = (await repo.list_tasks("goal_1"))[0]
    hired = await repo.get_agent(task["assigned_to"])
    assert hired["number"] == 71 and hired["role"] == "Rust Engineer" and hired["desk_id"] == "desk_eng_15"
    assert hired["reports_to"] == "agent_sora"
    assert orch.profiles[hired["agent_id"]]["skills"][:2] == ["rust", "webassembly"]
    event = [p for s, d in bus.ring if s > seq and (p := __import__("json").loads(d))["event"] == "AGENT_HIRED"][0]
    assert event["payload"]["x"] == -10.5 and event["payload"]["approved_by"] == "hrd"
    assert (await repo.hired_profiles())[hired["agent_id"]]["persona_prompt"].startswith("Kamu adalah")


async def test_hrd_borrows_instead_of_hiring(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = _orch(repo, tmp_path, ["copywriting"])
    await repo.create_goal("goal_1", "Bangun modul Rust", 2, False)
    await orch.plan_goal("goal_1")
    assert (await repo.list_tasks("goal_1"))[0]["assigned_to"] == "agent_kaito"
    assert len(await repo.list_agents()) == 70


async def test_hrd_asks_boss_when_unsure(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = _orch(repo, tmp_path, ["rust", "copywriting", "kotlin"])
    await repo.create_goal("goal_1", "Bangun modul Rust", 2, False)
    plan = asyncio.create_task(orch.plan_goal("goal_1"))
    for _ in range(200):
        await asyncio.sleep(0.01)
        if pending := await repo.list_approvals("PENDING"):
            break
    assert pending[0]["tool_name"] == "Rekrut_Karyawan" and pending[0]["agent_id"] == "agent_sena"
    assert await orch.gate.resolve(pending[0]["request_id"], False, "Belum perlu")
    await plan
    assert len(await repo.list_agents()) == 70
    assert (await repo.list_tasks("goal_1"))[0]["assigned_to"] == "agent_kenji"


async def test_old_database_allows_agent_number_above_50(tmp_path):
    """DB lama punya CHECK number 1..50; migrasi melonggarkannya tanpa membangun ulang tabel."""
    here = Path(__file__).parents[1] / "app" / "db"
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript((here / "schema.sql").read_text().replace("BETWEEN 1 AND 999", "BETWEEN 1 AND 50"))
    db.executescript((here / "seed.sql").read_text())
    db.close()
    repo = await Repo.open(str(path))
    try:
        profile = hr.new_profile(number=71, used_names=set(), role="", division="marketing", skills=["tiktok ads"],
                                 desk_id=await repo.free_desk("marketing"), lead_id="agent_ryota")
        row = await repo.hire_agent(profile, None, "uji", "hrd")
        assert row["number"] == 71 and row["role"] == "Tiktok Ads Specialist" and row["z"] == 19.0
    finally:
        await repo.close()


async def test_company_profile_only_for_company_work(repo, tmp_path):
    orch = _orch(repo, tmp_path, [])
    kanade = orch.profiles["agent_kanade"]
    about = await orch.context_for(kanade, "Susun content plan", "Siapkan media sosial resmi CyberVerse Corp")
    assert "[PROFIL PERUSAHAAN" in about and "Instagram" in about
    assert "[PROFIL PERUSAHAAN" not in await orch.context_for(kanade, "Susun content plan", "Landing page KopiKita")
    assert "[PROFIL PERUSAHAAN" not in await orch.context_for(kanade, "Buat website", "Company profile PT Rastekindo")
