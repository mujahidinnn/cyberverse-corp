import pytest

from app.config import settings
from app.llm.router import LLMRouter, QuotaExhausted

GROQ = "groq/qwen/qwen3.8-27b"
GEMINI = "gemini/gemini-3.5-flash-lite"
MISTRAL = "mistral/ministral-14b-latest"


@pytest.fixture
def router(monkeypatch):
    for k in ("GROQ_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.setenv(k, "x")
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    return LLMRouter(settings.llm_limits_path)


def test_unavailable_providers_skipped(router, monkeypatch):
    assert not any(m.startswith("ollama/") for m in router.limits)
    assert router.chains["T4_LOCAL_CODE"][0] == GROQ
    monkeypatch.delenv("GROQ_API_KEY")
    assert GROQ not in LLMRouter(settings.llm_limits_path).chains["T1_REASON"]


async def test_failover_on_rpm(router):
    router.limits[GROQ].rpm = 2
    picks = [(await router.acquire("T1_REASON", 1000, set())).model for _ in range(3)]
    assert picks == [GROQ, GROQ, GEMINI]


async def test_tpm_counts_actual_tokens(router):
    lease = await router.acquire("T1_REASON", 7000, set())
    await router.release(lease, 500)
    assert (await router.acquire("T1_REASON", 6000, set())).model == GROQ


async def test_rate_limit_cooldown(router):
    lease = await router.acquire("T2_FAST", 100, set())
    assert lease.model == MISTRAL
    await router.release(lease, None, rate_limited=True, retry_after=60)
    assert (await router.acquire("T2_FAST", 100, set())).model == GROQ


async def test_exhausted(router):
    with pytest.raises(QuotaExhausted):
        await router.acquire("T5_LOCAL_LIGHT", 100, {MISTRAL, GEMINI}, wait_s=0.1)
