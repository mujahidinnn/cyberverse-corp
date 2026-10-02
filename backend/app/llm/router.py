import asyncio
import os
import time
from collections import deque
from dataclasses import dataclass, field

import yaml

PROVIDER_ENV = {
    "groq": "GROQ_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "ollama": "OLLAMA_HOST",
}


@dataclass
class Limits:
    rpm: int | None
    rpd: int | None
    tpm: int | None
    tpd: int | None
    concurrency: int


@dataclass
class State:
    minute: deque = field(default_factory=deque)
    day_key: str = ""
    day_requests: int = 0
    day_tokens: int = 0
    in_flight: int = 0
    cooldown_until: float = 0.0


@dataclass
class Lease:
    model: str
    est: int
    entry: list


class QuotaExhausted(Exception):
    pass


def provider_available(model: str) -> bool:
    return bool(os.getenv(PROVIDER_ENV.get(model.split("/", 1)[0], ""), ""))


class LLMRouter:
    def __init__(self, limits_path: str) -> None:
        with open(limits_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        self.limits = {m: Limits(**v) for m, v in cfg["providers"].items() if provider_available(m)}
        self.chains = {tier: [m for m in chain if m in self.limits] for tier, chain in cfg["tiers"].items()}
        self.ollama_slots = cfg.get("ollama_global_concurrency", 1)
        self.state = {m: State() for m in self.limits}
        self._cond = asyncio.Condition()

    @staticmethod
    def estimate_tokens(prompt: str, max_tokens: int) -> int:
        return int(len(prompt) / 3.5) + max_tokens

    def _ollama_in_flight(self) -> int:
        return sum(s.in_flight for m, s in self.state.items() if m.startswith("ollama/"))

    def _fits(self, model: str, est: int, now: float) -> bool:
        lim, st = self.limits[model], self.state[model]
        day = time.strftime("%Y-%m-%d", time.gmtime(now - 7 * 3600))
        if st.day_key != day:
            st.day_key, st.day_requests, st.day_tokens = day, 0, 0
        while st.minute and now - st.minute[0][0] > 60:
            st.minute.popleft()
        if now < st.cooldown_until or st.in_flight >= lim.concurrency:
            return False
        if model.startswith("ollama/") and self._ollama_in_flight() >= self.ollama_slots:
            return False
        if lim.rpm is not None and len(st.minute) >= lim.rpm:
            return False
        if lim.tpm is not None and st.minute and sum(t for _, t in st.minute) + est > lim.tpm:
            return False
        if lim.rpd is not None and st.day_requests >= lim.rpd:
            return False
        if lim.tpd is not None and st.day_tokens + est > lim.tpd:
            return False
        return True

    async def acquire(self, tier: str, est: int, exclude: set[str], wait_s: float = 300) -> Lease:
        """Reservasi kuota pada model pertama yang muat; antre jika semua penuh."""
        chain = [m for m in self.chains.get(tier, []) if m not in exclude]
        if not chain:
            raise QuotaExhausted(f"{tier}: tidak ada provider tersisa")
        deadline = time.monotonic() + wait_s
        async with self._cond:
            while True:
                now = time.time()
                for model in chain:
                    if self._fits(model, est, now):
                        st = self.state[model]
                        entry = [now, est]
                        st.minute.append(entry)
                        st.day_requests += 1
                        st.day_tokens += est
                        st.in_flight += 1
                        return Lease(model, est, entry)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise QuotaExhausted(tier)
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=min(remaining, 5))
                except asyncio.TimeoutError:
                    pass

    async def release(self, lease: Lease, actual_tokens: int | None,
                      rate_limited: bool = False, retry_after: float | None = None) -> None:
        async with self._cond:
            st = self.state[lease.model]
            st.in_flight -= 1
            if actual_tokens is not None:
                st.day_tokens += actual_tokens - lease.est
                lease.entry[1] = actual_tokens
            if rate_limited:
                st.cooldown_until = time.time() + (retry_after or 30)
            self._cond.notify_all()

    def snapshot(self) -> list[dict]:
        out = []
        for model, lim in self.limits.items():
            st = self.state[model]
            out.append({
                "model": model,
                "rpd_used": st.day_requests, "rpd_limit": lim.rpd,
                "tpd_used": st.day_tokens, "tpd_limit": lim.tpd,
                "in_flight": st.in_flight,
                "cooldown_until": st.cooldown_until or None,
            })
        return out
