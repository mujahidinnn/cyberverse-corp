"""F2: review loop, mediasi Kazu, memori RAG, chat, aturan Supervisor: LLM di-stub."""
import hashlib

import pytest
from chromadb import Documents, EmbeddingFunction, Embeddings

from app.config import settings
from app.gate.approval import ApprovalGate
from app.llm.router import LLMRouter
from app.llm_orchestrator import (Decision, LLMOrchestrator, MediationVerdict, ReviewVerdict, Verdict)
from app.memory import Memory, chunk, format_context


class BagOfWords(EmbeddingFunction):
    """Embedding deterministik: histogram kata ter-hash (cukup untuk uji relevansi)."""

    def __init__(self) -> None:
        pass

    def __call__(self, input: Documents) -> Embeddings:
        out = []
        for doc in input:
            v = [0.0] * 64
            for w in doc.lower().split():
                v[int(hashlib.md5(w.encode()).hexdigest(), 16) % 64] += 1
            out.append(v)
        return out

    @staticmethod
    def name() -> str:
        return "bag_of_words_test"

    def get_config(self) -> dict:
        return {}

    @staticmethod
    def build_from_config(config: dict) -> "BagOfWords":
        return BagOfWords()


@pytest.fixture
def memory(tmp_path):
    return Memory(str(tmp_path / "chroma"), embedding_function=BagOfWords())


@pytest.fixture
def orch(repo, tmp_path, memory):
    return LLMOrchestrator(repo, ApprovalGate(repo), 6, LLMRouter(settings.llm_limits_path),
                           str(tmp_path / "ws"), settings.agents_path, memory)


async def _task(repo, reviewer="agent_aoi", max_iterations=5):
    await repo.create_goal("goal_1", "Bangun modul fibonacci", 2, False)
    return await repo.create_task({
        "task_id": "task_1", "goal_id": "goal_1", "epic_key": "E1", "title": "Tulis fibonacci",
        "description": "d", "division": "engineering", "assigned_to": "agent_kenji", "reviewer_id": reviewer,
        "created_by": "agent_sora", "status": "TODO", "max_iterations": max_iterations,
        "acceptance_json": '["3 test lulus"]'})


def test_chunk_and_reviewer_rule():
    assert chunk("") == [] and chunk("pendek") == ["pendek"]
    parts = chunk("x" * 2000)
    assert len(parts) == 3 and all(len(p) <= 800 for p in parts)
    assert LLMOrchestrator.reviewer_for("engineering", "agent_kenji", "agent_sora") == "agent_aoi"
    assert LLMOrchestrator.reviewer_for("engineering", "agent_aoi", "agent_sora") == "agent_sora"
    assert LLMOrchestrator.reviewer_for("creative", "agent_kaito", "agent_luna") == "agent_luna"
    assert LLMOrchestrator.reviewer_for("creative", "agent_luna", "agent_luna") is None


async def test_search_empty_until_ready(tmp_path):
    m = Memory(str(tmp_path / "c2"), embedding_function=BagOfWords())
    m.ready.clear()
    m.add_background("x", "fastapi sqlite", division="engineering")
    assert await m.search("fastapi", "engineering") == []
    m.ready.set()
    await m.drain()
    assert len(await m.search("fastapi sqlite", "engineering")) == 1


async def test_memory_relevance(memory):
    await memory.add("t1", "backend memakai fastapi dan sqlite wal", division="engineering", document_type="DECISION")
    await memory.add("t2", "palet warna brand kuning navy", division="creative", document_type="CONTENT")
    hits = await memory.search("fastapi sqlite backend", "engineering")
    assert [h["meta"]["document_type"] for h in hits] == ["DECISION"]
    assert await memory.search("fastapi sqlite backend", "marketing") == []
    block = format_context(hits, ["Selalu pakai type hints"])
    assert "ATURAN DARI SUPERVISOR" in block and "fastapi" in block


async def test_review_loop_then_approve(repo, orch):
    task = await _task(repo)
    verdicts = iter([Verdict.REQUEST_CHANGES, Verdict.APPROVE])
    prompts = []

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        prompts.append((profile["agent_id"], description))
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=next(verdicts), findings=["[MAJOR] test kurang"], bubble_line="Hmph!")
        return "laporan fibonacci selesai dengan pytest", None

    orch.run_agent = fake
    await orch.execute_task(task)
    t = await repo.get_task("task_1")
    assert t["status"] == "DONE" and t["iteration"] == 1
    assert [p[0] for p in prompts] == ["agent_kenji", "agent_aoi", "agent_kenji", "agent_aoi"]
    assert "[MAJOR] test kurang" in prompts[2][1]
    await orch.memory.drain()
    hits = await orch.memory.search("laporan fibonacci pytest", "engineering")
    assert hits and hits[0]["meta"]["task_id"] == "task_1"


async def test_mediation_after_max_iterations(repo, orch):
    task = await _task(repo, max_iterations=2)

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=Verdict.REQUEST_CHANGES, findings=["[MAJOR] x"], bubble_line="Lagi!")
        if output_model is MediationVerdict:
            return "", MediationVerdict(decision=Decision.ACCEPT_WITH_FOLLOWUP, reasons=["a", "b", "c"],
                                        followup_title="Tambah test edge case", bubble_line="Diterima.")
        return "laporan", None

    orch.run_agent = fake
    await orch.execute_task(task)
    tasks = {t["title"]: t for t in await repo.list_tasks("goal_1")}
    assert tasks["Tulis fibonacci"]["status"] == "DONE"
    assert tasks["Tambah test edge case"]["status"] == "TODO"
    assert tasks["Tambah test edge case"]["reviewer_id"] is None


async def test_review_loop_capped_at_two_revisions(repo, orch):
    """Bos tidak mau revisi tanpa akhir: maksimal 2 revisi walau task mengizinkan 5 iterasi."""
    task = await _task(repo, max_iterations=5)
    work = []

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=Verdict.REQUEST_CHANGES, findings=["[BLOCKER] x"], bubble_line="Lagi!")
        if output_model is MediationVerdict:
            return "", MediationVerdict(decision=Decision.ACCEPT_AS_IS, reasons=["a", "b", "c"], bubble_line="Cukup.")
        work.append(description)
        return "laporan", None

    orch.run_agent = fake
    await orch.execute_task(task)
    assert len(work) == 3
    assert (await repo.get_task("task_1"))["status"] == "DONE"


async def test_escalation_fails_task(repo, orch):
    task = await _task(repo, max_iterations=1)

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=Verdict.REQUEST_CHANGES, findings=[], bubble_line="Tidak.")
        if output_model is MediationVerdict:
            return "", MediationVerdict(decision=Decision.ESCALATE_TO_HUMAN, reasons=["a", "b", "c"], bubble_line="Eskalasi.")
        return "laporan", None

    orch.run_agent = fake
    await orch.execute_task(task)
    t = await repo.get_task("task_1")
    assert t["status"] == "FAILED" and t["error"].startswith("ESCALATED_TO_HUMAN")


async def test_chat_uses_history_rules_and_saves(repo, orch):
    await repo.add_rule("Selalu jawab dengan sopan", "global")
    seen = []

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        seen.append(description)
        return f"balasan {len(seen)}", None

    orch.run_agent = fake
    await orch.chat("agent_aoi", "Halo Aoi, status API?")
    await orch.chat("agent_aoi", "Oke, lanjut.")
    msgs = await repo.recent_messages("chat:agent_aoi")
    assert [m["content"] for m in msgs] == ["Halo Aoi, status API?", "balasan 1", "Oke, lanjut.", "balasan 2"]
    assert "Halo Aoi, status API?" in seen[1] and "balasan 1" in seen[1]
    assert "Selalu jawab dengan sopan" in seen[0]


async def test_failing_tests_bounce_without_llm_reviewer(repo, orch, monkeypatch, tmp_path):
    task = await _task(repo)
    (tmp_path / "ws" / "goal_1").mkdir(parents=True)
    (tmp_path / "ws" / "goal_1" / "test_x.py").write_text("def test_x(): assert False\n")
    results = iter(["exit_code=1\n1 failed", "exit_code=0\n3 passed"])
    monkeypatch.setattr("app.llm_orchestrator.run_sandbox", lambda *a, **k: next(results))
    calls = []

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        calls.append((profile["agent_id"], description))
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=Verdict.APPROVE, bubble_line="Oke.")
        return "laporan", None

    orch.run_agent = fake
    await orch.execute_task(task)
    assert [c[0] for c in calls] == ["agent_kenji", "agent_kenji", "agent_aoi"]
    assert "pytest gagal" in calls[1][1]
    assert "3 passed" in calls[2][1]
    assert (await repo.get_task("task_1"))["status"] == "DONE"


def test_delegate_skips_leads(orch):
    team = orch.team_of("agent_sora")
    assert orch.delegate(["python", "code_review"], team, {}, "agent_sora") != "agent_aoi"


def test_missing_claimed_files(tmp_path):
    from app.llm_orchestrator import missing_claimed_files
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "leap.py").write_text("x")
    report = "Dibuat `src/leap.py`, `leap.py`, dan `test_leap.py`; lihat juga `reports/a.md`."
    assert missing_claimed_files(report, tmp_path) == ["test_leap.py", "reports/a.md"]


async def test_hallucinated_files_bounce(repo, orch):
    task = await _task(repo)
    calls = []

    async def fake(profile, description, expected, *, task_id, tools=None, output_model=None):
        calls.append(profile["agent_id"])
        if output_model is ReviewVerdict:
            return "", ReviewVerdict(verdict=Verdict.APPROVE, bubble_line="Oke.")
        if len(calls) == 1:
            return "Sudah membuat `leap_year.py` dan 4 test lulus.", None
        return "Laporan jujur tanpa klaim file.", None

    orch.run_agent = fake
    await orch.execute_task(task)
    assert calls == ["agent_kenji", "agent_kenji", "agent_aoi"]
    assert (await repo.get_task("task_1"))["iteration"] == 1


def test_delegate_fallback_prefers_team_over_splitting_lead(orch):
    team = orch.team_of("agent_sora")
    assert orch.delegate(["task_breakdown"], team, {}, "agent_sora") == "agent_aoi"
    assert orch.delegate(["origami"], team, {}, "agent_sora") == "agent_sora"


def test_instructor_wrapped_error_triggers_failover():
    from instructor.core.exceptions import InstructorRetryException
    from app.llm_orchestrator import _is_provider_error
    assert _is_provider_error(InstructorRetryException("GroqException - Temporary failure in name resolution", n_attempts=1, total_usage=0))
    assert not _is_provider_error(ValueError("bug lokal"))
