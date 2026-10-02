"""Tool CrewAI yang melewati classifier risiko + Approval Gate (PRD §5, §17.5)."""
import asyncio
import functools
import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import re

import httpx
from crewai.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

from app.gate.approval import ApprovalGate, Risk, classify
from app.ws.gateway import bus

SANDBOX_IMAGE = os.getenv("SANDBOX_IMAGE", "cyberverse-sandbox:0.1")
OUTPUT_LIMIT = 20_000
MAX_WRITE_BYTES = 1_000_000


@dataclass
class ToolContext:
    agent_id: str
    task_id: str
    workspace: Path
    gate: ApprovalGate
    repo: Any
    loop: asyncio.AbstractEventLoop
    is_cancelled: Callable[[], bool]
    searches: int = 0
    image_searches: int = 0

    def call(self, coro) -> Any:
        """Jalankan coroutine di event loop utama dari thread CrewAI, tunggu hasilnya."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()

    def visual(self, status: str, **extra: Any) -> None:
        self.loop.call_soon_threadsafe(functools.partial(bus.publish_agent_state, self.agent_id, status=status, **extra))


def safe_path(workspace: Path, rel: str) -> Path:
    root = workspace.resolve()
    p = (root / rel).resolve()
    if not p.is_relative_to(root):
        raise ValueError("path di luar workspace")
    return p


def run_sandbox(workspace: Path, cmd: list[str], network: bool, timeout: int = 120) -> str:
    name = f"cv-sbx-{uuid.uuid4().hex[:10]}"
    args = [
        "docker", "run", "--rm", "--name", name,
        "--network", "bridge" if network else "none",
        "--cpus=1", "--memory=1g", "--pids-limit=256",
        "--read-only", "--tmpfs", "/tmp:rw,size=256m",
        "--cap-drop=ALL", "--security-opt", "no-new-privileges",
        "-u", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp", "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-v", f"{workspace.resolve()}:/workspace", "-w", "/workspace",
        SANDBOX_IMAGE, *cmd,
    ]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        return f"TIMEOUT: dihentikan setelah {timeout} dtk"
    out = r.stdout + (f"\n[stderr]\n{r.stderr}" if r.stderr else "")
    return f"exit_code={r.returncode}\n{out.strip()[-OUTPUT_LIMIT:]}"


def _write(ctx: ToolContext, path: str, content: str) -> str:
    data = content.encode()
    if len(data) > MAX_WRITE_BYTES:
        raise ValueError("file > 1 MB")
    p = safe_path(ctx.workspace, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return f"OK: {path} ditulis ({len(data)} byte)"


def _edit(ctx: ToolContext, path: str, old: str, new: str) -> str:
    """Ganti satu potongan teks yang persis (revisi kecil tanpa menulis ulang seluruh file)."""
    p = safe_path(ctx.workspace, path)
    text = p.read_text(encoding="utf-8")
    n = text.count(old) if old else 0
    if n != 1:
        return (f"GAGAL: potongan lama ditemukan {n} kali di {path}; harus tepat 1. Salin persis dari File_Read "
                "dan sertakan beberapa baris di sekitarnya agar unik.")
    p.write_text(text.replace(old, new), encoding="utf-8")
    return f"OK: {path} diubah ({len(old)} karakter diganti {len(new)} karakter)"


def _read(ctx: ToolContext, path: str) -> str:
    return safe_path(ctx.workspace, path).read_text(errors="replace")[:OUTPUT_LIMIT]


def _list(ctx: ToolContext, path: str = ".") -> str:
    base = safe_path(ctx.workspace, path)
    files = sorted(str(f.relative_to(ctx.workspace.resolve())) for f in base.rglob("*")
                   if f.is_file() and "__pycache__" not in f.parts and ".pytest_cache" not in f.parts)
    return "\n".join(files[:200]) or "(kosong)"


def _python(ctx: ToolContext, path: str) -> str:
    safe_path(ctx.workspace, path)
    return run_sandbox(ctx.workspace, ["python", path], network=False)


def _pytest(ctx: ToolContext, path: str = ".") -> str:
    safe_path(ctx.workspace, path)
    return run_sandbox(ctx.workspace, ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", path], network=False)


def _terminal(ctx: ToolContext, command: str) -> str:
    return run_sandbox(ctx.workspace, ["sh", "-c", command], network=True)


_UNSPLASH_ID = re.compile(r"unsplash\.com/photos/(?:[\w-]*-)?([A-Za-z0-9_]{11})(?:[/?#]|$)")


def _unsplash_image(photo_id: str) -> str | None:
    """Ubah id foto Unsplash jadi URL gambar langsung (redirect endpoint unduhan), ukuran web."""
    try:
        r = httpx.get(f"https://unsplash.com/photos/{photo_id}/download?w=1600", timeout=15, follow_redirects=False,
                      headers={"User-Agent": "Mozilla/5.0 CyberVerse"})
    except httpx.HTTPError:
        return None
    url = r.headers.get("location", "")
    return url.split("?")[0] + "?auto=format&fit=crop&w=1600&q=80" if url.startswith("https://images.unsplash.com/") else None


def find_unsplash(query: str, count: int = 4, skip: set[str] = frozenset()) -> list[tuple[str, str]]:
    """(judul, URL gambar langsung) foto Unsplash sungguhan, lewat Tavily (khusus unsplash.com)."""
    r = httpx.post("https://api.tavily.com/search", timeout=20,
                   headers={"Authorization": f"Bearer {os.environ['TAVILY_API_KEY']}"},
                   json={"query": f"{query[:300]} photo", "max_results": 10, "include_domains": ["unsplash.com"]})
    r.raise_for_status()
    found = []
    for h in r.json().get("results", []):
        m = _UNSPLASH_ID.search(h.get("url", ""))
        if m and (img := _unsplash_image(m.group(1))) and img not in skip:
            found.append((h.get("title", "")[:90], img))
        if len(found) >= count:
            break
    return found


MAX_IMAGE_SEARCHES = 8


def _image_search(ctx: ToolContext, query: str, count: int = 4) -> str:
    """Foto Unsplash sungguhan (URL gambar yang pasti ada) untuk dipakai di website; model jangan mengarang id foto."""
    if ctx.image_searches >= MAX_IMAGE_SEARCHES:
        return "Batas pencarian gambar tercapai. Pakai URL gambar yang sudah didapat."
    ctx.image_searches += 1
    found = find_unsplash(query, count)
    return ("\n".join(f"- {title}\n  {url}" for title, url in found)
            or "Tidak ada foto yang cocok; coba kata kunci lain (bahasa Inggris, lebih umum).")


def search_enabled() -> bool:
    return bool(os.getenv("TAVILY_API_KEY"))


MAX_SEARCHES = 3


def _search(ctx: ToolContext, query: str) -> str:
    """Pencarian web lewat Tavily API (tier gratis). Mesin pencari biasa memblokir atau mengacak hasil untuk bot."""
    if ctx.searches >= MAX_SEARCHES:
        return (f"Batas {MAX_SEARCHES} pencarian untuk task ini sudah tercapai. Jangan mencari lagi; "
                "lanjutkan pekerjaan sekarang dengan hasil yang sudah ada.")
    ctx.searches += 1
    r = httpx.post("https://api.tavily.com/search", timeout=20,
                   headers={"Authorization": f"Bearer {os.environ['TAVILY_API_KEY']}"},
                   json={"query": query[:400], "max_results": 6, "search_depth": "basic"})
    r.raise_for_status()
    hits = r.json().get("results", [])
    return "\n".join(f"- {h.get('title', '')}\n  {h.get('url', '')}\n  {(h.get('content') or '')[:300]}"
                     for h in hits) or "Tidak ada hasil."


_JUST = Field(default="", description="Satu kalimat alasan memakai tool ini.")


class EditArgs(BaseModel):
    path: str = Field(description="Path relatif di workspace, mis. index.html")
    old: str = Field(description="Potongan teks lama yang persis sama dengan isi file (harus unik)")
    new: str = Field(description="Teks pengganti")
    justification: str = _JUST


class WriteArgs(BaseModel):
    path: str = Field(description="Path relatif di workspace, mis. src/app.py")
    content: str = Field(description="Isi file lengkap")
    justification: str = _JUST


class PathArgs(BaseModel):
    path: str = Field(default=".", description="Path relatif di workspace")
    justification: str = _JUST


class SearchArgs(BaseModel):
    query: str = Field(description="Kata kunci pencarian, mis. dribbble company profile website")
    justification: str = _JUST


class ImageSearchArgs(BaseModel):
    query: str = Field(description="Subjek foto dalam bahasa Inggris, mis. industrial pipe insulation worker")
    count: int = Field(default=4, ge=1, le=8, description="Jumlah foto")
    justification: str = _JUST


class CommandArgs(BaseModel):
    command: str = Field(description="Perintah shell (dijalankan di sandbox dengan akses internet)")
    justification: str = _JUST


REGISTRY: dict[str, tuple[str, Risk, type[BaseModel], Callable[..., str]]] = {
    "File_Write": ("Tulis/timpa file di workspace goal.", Risk.MEDIUM, WriteArgs, _write),
    "File_Edit": ("Ubah bagian tertentu sebuah file: ganti potongan teks lama yang persis dengan teks baru. Lebih aman "
                  "daripada menulis ulang seluruh file untuk revisi.", Risk.MEDIUM, EditArgs, _edit),
    "File_Read": ("Baca isi file di workspace goal.", Risk.LOW, PathArgs, _read),
    "File_List": ("Daftar file di workspace goal.", Risk.LOW, PathArgs, _list),
    "Python_Runner": ("Jalankan skrip Python di sandbox tanpa internet. Arg path = file .py.",
                      Risk.MEDIUM, PathArgs, _python),
    "PyTest_Runner": ("Jalankan pytest di sandbox tanpa internet. Arg path = folder/file test.",
                      Risk.MEDIUM, PathArgs, _pytest),
    "Terminal_Execute": ("Jalankan perintah shell di sandbox DENGAN internet (mis. pip install). "
                         "Butuh persetujuan manusia.", Risk.HIGH, CommandArgs, _terminal),
    "Image_Search": ("Cari foto Unsplash sungguhan untuk website (hasil: URL gambar langsung yang pasti bisa dipakai di "
                     "<img src>). Jangan mengarang URL images.unsplash.com.", Risk.LOW, ImageSearchArgs, _image_search),
    "Web_Search": ("Cari di web (judul, URL, cuplikan). Pakai untuk riset; kutip URL hanya dari hasil tool ini.",
                   Risk.LOW, SearchArgs, _search),
}


class GatedTool(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    base_risk: Risk
    ctx: Any
    impl: Any

    def _run(self, justification: str = "", **kwargs: Any) -> str:
        ctx: ToolContext = self.ctx
        if ctx.is_cancelled():
            return "CANCELLED: task dibatalkan. Hentikan pekerjaan dan beri jawaban akhir singkat."
        c = classify(self.name, self.base_risk, kwargs)
        request_id = None
        if c.risk is Risk.FORBIDDEN:
            return self._finish(c, kwargs, "DENIED", f"FORBIDDEN: {c.reason}. Aksi ini tidak diizinkan; cari cara lain.", 0)
        if c.risk is Risk.HIGH:
            approved, note, request_id = ctx.call(ctx.gate.request(
                agent_id=ctx.agent_id, task_id=ctx.task_id, tool_name=self.name, tool_input=kwargs,
                reason=c.reason, justification=justification or None))
            if not approved:
                return self._finish(c, kwargs, "REJECTED", note, 0, request_id)
        ctx.visual("WORKING", emotion_icon=None)
        started = time.monotonic()
        try:
            out, status = str(self.impl(ctx, **kwargs))[:OUTPUT_LIMIT], "SUCCEEDED"
        except Exception as exc:
            out, status = f"TOOL_ERROR: {type(exc).__name__}: {exc}", "FAILED"
        ctx.visual("THINKING", emotion_icon="thought")
        return self._finish(c, kwargs, status, out, int((time.monotonic() - started) * 1000), request_id)

    def _finish(self, c, kwargs: dict, status: str, out: str, ms: int, request_id: str | None = None) -> str:
        ctx: ToolContext = self.ctx
        preview = {k: (v[:200] + "…" if isinstance(v, str) and len(v) > 200 else v) for k, v in kwargs.items()}
        ctx.call(ctx.repo.log_tool(task_id=ctx.task_id, agent_id=ctx.agent_id, tool_name=self.name,
                                   risk_level=c.risk.value, request_id=request_id,
                                   input_json=json.dumps(preview, ensure_ascii=False),
                                   output_text=out[:4000], status=status, duration_ms=ms))
        ctx.loop.call_soon_threadsafe(functools.partial(bus.publish, "TOOL_EXECUTION_LOG", {
            "agent_id": ctx.agent_id, "task_id": ctx.task_id, "tool_name": self.name,
            "risk_level": c.risk.value, "status": status, "input": preview}))
        return out


def build_tools(names: list[str], ctx: ToolContext) -> list[BaseTool]:
    tools = []
    for name in names:
        desc, risk, schema, impl = REGISTRY[name]
        tools.append(GatedTool(name=name, description=desc, args_schema=schema, base_risk=risk, ctx=ctx, impl=impl))
    return tools
