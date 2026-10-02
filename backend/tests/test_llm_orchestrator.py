"""Planning F1 dengan LLM di-stub: roadmap → breakdown → task, delegasi skill & dependensi antar-epic."""
from app.config import settings
from app.gate.approval import ApprovalGate
from app.llm.router import LLMRouter
import asyncio

from app.llm_orchestrator import DESIGN_EPIC, Epic, _is_provider_error, LLMOrchestrator, Roadmap, TaskBreakdown, TaskSpec
from app.sim import Orchestrator


def spec(key, skills, deps=(), title=None):
    return TaskSpec(key=key, title=title or f"Task {key}", description="d", required_skills=skills,
                    acceptance_criteria=["ok"], depends_on=list(deps), handoff_line="Ayo")


async def _no_pause(_):
    return None


async def test_plan_goal_creates_delegated_tasks(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)
    calls = []

    async def fake_run_agent(profile, description, expected, *, task_id, tools=None, output_model=None):
        calls.append(profile["agent_id"])
        if output_model is Roadmap:
            return "", Roadmap(goal_summary="Landing page", epics=[
                Epic(key="E1", title="Build", division="engineering", objective="o", success_criteria=["c"]),
                Epic(key="E2", title="Copy", division="creative", objective="o", success_criteria=["c"],
                     depends_on=["E1"])])
        if profile["agent_id"] == "agent_sora":
            return "", TaskBreakdown(tasks=[spec("T1", ["python", "fastapi"]), spec("T2", ["testing", "pytest"], ["T1"])])
        return "", TaskBreakdown(tasks=[spec("T1", ["copywriting", "headline"], title="Headline")])

    orch.run_agent = fake_run_agent
    goal = await repo.create_goal("goal_1", "Bangun layanan pesanan", 2, False)
    await orch.plan_goal(goal["goal_id"])

    assert calls == ["agent_ren", "agent_sora", "agent_luna"]
    tasks = {t["title"]: t for t in await repo.list_tasks("goal_1")}
    assert tasks["Task T1"]["assigned_to"] == "agent_kenji"
    t2 = [t for t in tasks.values() if t["assigned_to"] == "agent_neko_bot"]
    assert t2, "testing+pytest → Neko-Bot"
    copy = next(t for t in tasks.values() if t["division"] == "creative")
    assert copy["assigned_to"] == "agent_kaito"
    assert len(await repo.dependency_ids(copy["task_id"])) == 2
    assert await repo.dependency_ids(t2[0]["task_id"]) == [tasks["Task T1"]["task_id"]]
    assert (await repo.get_goal("goal_1"))["status"] == "RUNNING"
    minutes = await repo.goal_kickoff("goal_1")
    assert "## Arahan" in minutes and "| Headline | Kaito" in minutes
    assert (await repo.get_agent("agent_sora"))["status"] == "IDLE"
    assert await repo.running_meeting() is None


async def test_planning_failure_marks_goal_failed(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)

    async def boom(*a, **k):
        raise RuntimeError("Semua model gagal")

    orch.run_agent = boom
    await repo.create_goal("goal_2", "Bangun sesuatu yang besar", 2, False)
    await orch.plan_goal("goal_2")
    assert (await repo.get_goal("goal_2"))["status"] == "FAILED"


async def test_website_goal_starts_with_design_without_waiting_for_boss(repo, tmp_path, monkeypatch):
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)

    async def fake_run_agent(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is Roadmap:
            return "", Roadmap(goal_summary="Website", epics=[
                Epic(key="E1", title="Build", division="engineering", objective="o", success_criteria=["c"])])
        if output_model is TaskBreakdown:
            return "", TaskBreakdown(tasks=[spec("T1", ["typescript"])])
        (tmp_path / "ws" / "goal_1" / "design.html").write_text("<html></html>")
        return "Arah desain: bersih.", None

    orch.run_agent = fake_run_agent
    await repo.create_goal("goal_1", "Buat website toko kopi", 2, False)
    await orch.plan_goal("goal_1")
    design, build = sorted(await repo.list_tasks("goal_1"), key=lambda t: t["epic_key"] != DESIGN_EPIC)
    assert design["assigned_to"] == "agent_yuki" and await repo.dependency_ids(build["task_id"]) == [design["task_id"]]
    assert [t["task_id"] for t in await repo.ready_tasks(5)] == [design["task_id"]]
    await orch.execute_task(design)
    assert (await repo.get_task(design["task_id"]))["status"] == "DONE"
    assert await repo.list_approvals("PENDING") == []
    assert [t["task_id"] for t in await repo.ready_tasks(5)] == [build["task_id"]]


async def test_failed_design_is_skipped_and_coding_still_runs(repo, tmp_path, monkeypatch):
    """Model membalas kosong saat membuat desain: desain dilewati, goal tidak ikut gagal."""
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)

    async def fake_run_agent(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is Roadmap:
            return "", Roadmap(goal_summary="Website", epics=[
                Epic(key="E1", title="Build", division="engineering", objective="o", success_criteria=["c"])])
        if output_model is TaskBreakdown:
            return "", TaskBreakdown(tasks=[spec("T1", ["typescript"])])
        raise RuntimeError("Semua model gagal untuk T3_DOC: ValueError: Invalid response from LLM call - None or empty.")

    orch.run_agent = fake_run_agent
    await repo.create_goal("goal_1", "Buat website toko kopi", 2, False)
    await orch.plan_goal("goal_1")
    design, build = sorted(await repo.list_tasks("goal_1"), key=lambda t: t["epic_key"] != DESIGN_EPIC)
    await orch.execute_task(design)
    assert (await repo.get_task(design["task_id"]))["status"] == "CANCELLED"
    assert [t["task_id"] for t in await repo.ready_tasks(5)] == [build["task_id"]]
    await repo.update_task(build["task_id"], status="DONE")
    await orch._maybe_finish_goal("goal_1")
    assert (await repo.get_goal("goal_1"))["status"] == "DONE"


def test_empty_model_reply_triggers_failover():
    assert _is_provider_error(ValueError("Invalid response from LLM call - None or empty."))
    assert not _is_provider_error(ValueError("bug kita sendiri"))


async def test_failed_prerequisite_cancels_dependents_and_closes_goal(repo):
    orch = Orchestrator(repo, ApprovalGate(repo), 6)
    await repo.create_goal("goal_1", "Bangun sesuatu yang besar", 2, False)
    await repo.set_goal("goal_1", "RUNNING")
    base = {"goal_id": "goal_1", "division": "engineering", "assigned_to": "agent_kenji", "created_by": "human"}
    await repo.create_task(base | {"task_id": "t1", "title": "A", "status": "FAILED"})
    await repo.create_task(base | {"task_id": "t2", "title": "B", "status": "TODO"})
    await repo.add_dependency("t2", "t1")
    await orch._maybe_finish_goal("goal_1")
    assert (await repo.get_task("t2"))["status"] == "CANCELLED"
    assert (await repo.get_goal("goal_1"))["status"] == "FAILED"


def test_web_search_tool_only_with_key(tmp_path, monkeypatch):
    import httpx
    from app import tools

    orch = LLMOrchestrator(None, None, 6, LLMRouter(settings.llm_limits_path), str(tmp_path), settings.agents_path)
    yuki = orch.profiles["agent_yuki"]
    names = lambda: {t.name for t in orch._tools_for(yuki, "t", tmp_path)}
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setattr("asyncio.get_running_loop", lambda: None)
    assert "Web_Search" not in names()
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-x")
    assert "Web_Search" in names()

    def fake_post(url, **kw):
        assert kw["headers"]["Authorization"] == "Bearer tvly-x" and kw["json"]["query"] == "dribbble landing page"
        return httpx.Response(200, json={"results": [{"title": "Shot", "url": "https://dribbble.com/s/1", "content": "Hero"}]},
                              request=httpx.Request("POST", url))
    monkeypatch.setattr(httpx, "post", fake_post)
    ctx = type("Ctx", (), {"searches": 0})()
    assert tools._search(ctx, "dribbble landing page") == "- Shot\n  https://dribbble.com/s/1\n  Hero"
    ctx.searches = tools.MAX_SEARCHES
    assert tools._search(ctx, "dribbble landing page").startswith("Batas")


async def test_continuation_prompt_carries_previous_versions(repo, tmp_path):
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path), str(tmp_path), settings.agents_path)
    await repo.create_goal("goal_v1", "Buat website toko kopi", 2, False)
    await repo.set_goal_report("goal_v1", None, "index.html selesai dengan hero dan menu.")
    v2 = await repo.create_goal("goal_v2", "Tambah halaman kontak", 2, False, "goal_v1")
    note = await orch.lineage_note(v2)
    assert "1. Buat website toko kopi" in note and "hero dan menu" in note and "Tambah halaman kontak" not in note
    assert await orch.lineage_note(await repo.get_goal("goal_v1")) == ""


async def test_failed_goal_gets_plain_diagnosis_and_fix_options(repo, tmp_path, monkeypatch):
    """Gagal → bos dapat penyebab bahasa awam + pilihan perintah siap kirim, termasuk saat LLM ikut gagal."""
    import json
    from app.llm_orchestrator import FixOption, Recovery
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)

    async def boom(*a, **k):
        raise RuntimeError("Semua model gagal untuk T1_REASON: RateLimitError")

    orch.run_agent = boom
    await repo.create_goal("goal_1", "Buat website toko kopi", 2, False)
    await orch.plan_goal("goal_1")
    rec = json.loads((await repo.get_goal("goal_1"))["recovery_json"])
    assert "kuota" in rec["diagnosis"] and "RateLimit" not in rec["diagnosis"]
    assert [o["prompt"] for o in rec["options"]][-1] == "Buat website toko kopi"

    async def daichi(profile, description, expected, *, task_id, tools=None, output_model=None):
        assert profile["agent_id"] == "agent_daichi" and output_model is Recovery
        return "", Recovery(diagnosis="Permintaannya terlalu luas untuk sekali jalan.", options=[
            FixOption(title="Pecah jadi halaman utama dulu", detail="Lebih kecil, lebih pasti jadi.",
                      prompt="Buat halaman utama website toko kopi saja: hero, menu, dan kontak."),
            FixOption(title="kosong", detail="", prompt="x")])
    orch.run_agent = daichi
    rec = await orch.save_recovery("goal_1")
    assert rec["diagnosis"].startswith("Permintaannya terlalu luas")
    assert [o["title"] for o in rec["options"]] == ["Pecah jadi halaman utama dulu", "Sederhanakan dulu",
                                                    "Ulangi persis seperti semula"]


async def test_website_gets_visual_fix_rounds_and_sees_boss_attachments(repo, tmp_path, monkeypatch):
    """Coder melihat lampiran bos; screenshot dinilai sekali, skor rendah = satu putaran perbaikan tampilan."""
    from app.llm_orchestrator import ReviewVerdict, Verdict
    monkeypatch.setattr("app.sim._pause", _no_pause)
    orch = LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path)
    refs = tmp_path / "ws" / "goal_1" / "references"
    refs.mkdir(parents=True)
    (refs / "brief.md").write_text("Warna utama hijau daun.")
    (refs / "ref.png").write_bytes(b"\x89PNG")
    (refs / "ref.png.md").write_text("Hero dengan foto biji kopi di kanan.")
    reviews, prompts = [], []

    scores = iter([50, 70, 40, 30])

    async def fake_review(router, html, goal_prompt, references=None):
        reviews.append([r.name for r in references or []])
        return next(scores), ["Hero terlalu kosong: tambahkan ilustrasi di kanan"]
    monkeypatch.setattr("app.vision.review_page", fake_review)

    async def fake_run_agent(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=Verdict.APPROVE, findings=[], bubble_line="Oke.")
        prompts.append(description)
        (tmp_path / "ws" / "goal_1" / "index.html").write_text(f"<html>versi {len(prompts)}</html>")
        return "index.html selesai.", None

    orch.run_agent = fake_run_agent
    await repo.create_goal("goal_1", "Buat website toko kopi", 2, False)
    await repo.create_task({"task_id": "t1", "goal_id": "goal_1", "title": "Koding", "division": "engineering",
                            "assigned_to": "agent_momo", "reviewer_id": "agent_aoi", "created_by": "agent_sora"})
    await orch.execute_task(await repo.get_task("t1"))
    assert "Warna utama hijau daun" in prompts[0] and "foto biji kopi" in prompts[0]
    assert reviews == [["ref.png"]] * 4
    assert "Hero terlalu kosong" in prompts[1] and len(prompts) == 4
    page = (tmp_path / "ws" / "goal_1" / "index.html").read_text()
    assert page == "<html>versi 2</html>"
    assert (await repo.get_task("t1"))["status"] == "DONE"


def test_image_urls_found_for_broken_check():
    from app.vision import _IMG_URL
    html = '<img src="https://images.unsplash.com/photo-1"><div style="background:url(\'https://x.test/a.jpg\')">'
    assert _IMG_URL.findall(html) == ["https://images.unsplash.com/photo-1", "https://x.test/a.jpg"]


def test_file_edit_replaces_exactly_one_snippet(tmp_path):
    from app import tools
    ctx = type("Ctx", (), {"workspace": tmp_path})()
    (tmp_path / "index.html").write_text("<h1>Lama</h1><p>a</p><p>a</p>")
    assert tools._edit(ctx, "index.html", "<h1>Lama</h1>", "<h1>Baru</h1>").startswith("OK")
    assert tools._edit(ctx, "index.html", "<p>a</p>", "<p>b</p>").startswith("GAGAL")
    assert (tmp_path / "index.html").read_text() == "<h1>Baru</h1><p>a</p><p>a</p>"


async def test_broken_images_are_replaced_by_real_unsplash_photos(tmp_path, monkeypatch):
    from app import tools
    orch = LLMOrchestrator(None, None, 6, LLMRouter(settings.llm_limits_path), str(tmp_path), settings.agents_path)
    page = tmp_path / "index.html"
    page.write_text('<img src="https://images.unsplash.com/photo-palsu" alt="Pipe Insulation">'
                    '<div style="background:url(https://images.unsplash.com/photo-palsu)"></div>')
    queries = []

    async def broken(html):
        return ["https://images.unsplash.com/photo-palsu"] if "palsu" in html else []
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-x")
    monkeypatch.setattr("app.vision.broken_images", broken)
    monkeypatch.setattr(tools, "find_unsplash", lambda q, n, skip: queries.append(q) or [("t", "https://images.unsplash.com/photo-asli")])
    await orch._repair_images(page, "website")
    assert queries == ["industrial Pipe Insulation"] and "palsu" not in page.read_text()
    assert page.read_text().count("photo-asli") == 2
