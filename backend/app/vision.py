"""Mata tim: membaca gambar lampiran Supervisor dan menilai tampilan website hasil kerja lewat screenshot.

Model teks gratis tidak bisa melihat gambar, jadi gambar diubah menjadi deskripsi (sekali per file) dan website
dipotret dengan Chrome headless lalu dinilai model ber-vision.
"""
import asyncio
import base64
import contextlib
import json
import logging
import os
import re
import shutil
import signal
import tempfile
from pathlib import Path

import httpx
import litellm

from app.llm.router import LLMRouter, QuotaExhausted

log = logging.getLogger(__name__)

VISION_MODELS = ["gemini/gemini-3.5-flash-lite", "mistral/ministral-14b-latest"]
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}


async def look(router: LLMRouter, images: list[tuple[bytes, str]], prompt: str, max_tokens: int = 900) -> str | None:
    """Tanya model ber-vision tentang satu atau beberapa gambar (bytes, mime). None bila semua model vision gagal."""
    content = [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}}
        for data, mime in images]
    for model in VISION_MODELS:
        if model not in router.limits:
            continue
        try:
            lease = await router.acquire("T3_DOC", 1500 * len(images) + max_tokens, exclude=set(router.limits) - {model},
                                         wait_s=60)
        except QuotaExhausted:
            continue
        used = None
        try:
            resp = await litellm.acompletion(model=model, max_tokens=max_tokens, timeout=120, num_retries=1,
                                             messages=[{"role": "user", "content": content}])
            used = resp.usage.total_tokens if resp.usage else None
            text = (resp.choices[0].message.content or "").strip()
            if text:
                return text
        except Exception as exc:
            log.warning("vision %s gagal: %s", model, type(exc).__name__)
        finally:
            await router.release(lease, used)
    return None


def chrome() -> str | None:
    return os.getenv("CHROME_BIN") or shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")


async def screenshot(html: Path, width: int = 1280, height: int = 900, max_height: int = 9000) -> bytes | None:
    """Potret SELURUH halaman HTML lokal lewat Chrome DevTools: viewport tetap 1280x900 (unit vh tidak melar),
    tangkapan melewati viewport. None bila Chrome tidak ada atau gagal."""
    binary = chrome()
    if not binary or not html.is_file():
        return None
    import websockets
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        proc = await asyncio.create_subprocess_exec(
            binary, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--remote-debugging-port=0",
            f"--user-data-dir={tmp}", f"--window-size={width},{height}", "about:blank",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        try:
            return await asyncio.wait_for(_capture(Path(tmp), html, width, height, max_height, websockets), timeout=90)
        except Exception as exc:
            log.warning("screenshot %s gagal: %s", html.name, type(exc).__name__)
            return None
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()


async def _capture(profile: Path, html: Path, width: int, height: int, max_height: int, websockets) -> bytes:
    port_file = profile / "DevToolsActivePort"
    while not port_file.exists():
        await asyncio.sleep(0.2)
    port = port_file.read_text().split()[0]
    async with httpx.AsyncClient() as client:
        page = next(t for t in (await client.get(f"http://127.0.0.1:{port}/json")).json() if t["type"] == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=64 * 2**20) as ws:
        seq = 0

        async def call(method: str, **params):
            nonlocal seq
            seq += 1
            await ws.send(json.dumps({"id": seq, "method": method, "params": params}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == seq:
                    return msg.get("result", {})

        await call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=False)
        await call("Page.navigate", url=html.resolve().as_uri())
        await asyncio.sleep(6)
        size = (await call("Page.getLayoutMetrics"))["cssContentSize"]
        full = min(int(size["height"]), max_height)
        shot = await call("Page.captureScreenshot", format="jpeg", quality=80, captureBeyondViewport=True,
                          clip={"x": 0, "y": 0, "width": width, "height": full, "scale": 1})
        return base64.b64decode(shot["data"])


async def make_preview(workspace: Path) -> Path | None:
    """Thumbnail hasil goal: screenshot bagian atas halaman utama (index.html, atau HTML/SVG pertama) ke
    reports/preview.jpg. Folder reports tidak ikut lampiran hasil dan tidak disalin ke versi lanjutan."""
    out = workspace / "reports" / "preview.jpg"
    if out.is_file():
        return out
    async with _preview_slots:
        if out.is_file():
            return out
        return await _render_preview(workspace, out)


_preview_slots = asyncio.Semaphore(2)


async def _render_preview(workspace: Path, out: Path) -> Path | None:
    pages = sorted(p for p in workspace.glob("*") if p.suffix.lower() in (".html", ".svg"))
    page = next((p for p in pages if p.name == "index.html"), None) or next(
        (p for p in pages if p.name != "design.html"), None) or (pages[0] if pages else None)
    if page is None:
        return None
    shot = await screenshot(page, max_height=800)
    if shot is None:
        return None
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(shot)
    return out


DESCRIBE = ("Ini gambar referensi dari bos. Tim yang TIDAK bisa melihat gambar harus membuat ulang tampilannya "
            "semirip mungkin, jadi tulis BLUEPRINT detail dalam bahasa Indonesia, bagian per bagian dari atas ke bawah. "
            "Untuk tiap bagian sebut: nama bagian; latar (warna hex, foto apa, gradien); bentuk wadah (lebar penuh atau "
            "kartu bersudut membulat, perkiraan radius); tata letak (kolom, posisi teks dan gambar, perataan); SEMUA teks "
            "yang terbaca persis (judul, label kecil/badge, paragraf, tombol, menu); ukuran dan ketebalan huruf relatif; "
            "warna teks dan aksen; bentuk tombol (pill, warna, ikon panah); jumlah dan susunan foto atau kartu beserta "
            "isi fotonya. Akhiri dengan palet warna (hex) dan jenis font yang paling mirip dari Google Fonts. Untuk "
            "gambar yang bukan desain halaman, cukup jelaskan isinya. Maksimal 900 kata.")


async def describe_references(router: LLMRouter, folder: Path) -> None:
    """Buat <gambar>.md berisi deskripsi untuk tiap gambar lampiran yang belum punya."""
    if not folder.is_dir():
        return
    for img in sorted(folder.iterdir()):
        mime = IMAGE_TYPES.get(img.suffix.lower())
        note = img.with_name(img.name + ".md")
        if not mime or note.exists():
            continue
        text = await look(router, [(img.read_bytes(), mime)], DESCRIBE, max_tokens=2000)
        note.write_text(text or "Deskripsi gambar tidak tersedia (model vision sedang tidak bisa dipakai).",
                        encoding="utf-8")


REVIEW = ("Ini screenshot satu halaman penuh (lebar 1280px) website hasil kerja tim untuk permintaan berikut:\n{goal}\n\n"
          "Nilai tampilannya seperti art director yang teliti: ruang kosong berlebihan, hierarki dan ukuran tipografi, "
          "kontras teks, jarak dan perataan, konsistensi warna, kualitas visual (foto, ikon), kesan profesional. Jawab "
          'HANYA JSON: {{"score": 0-100, "fixes": ["maks 6 perbaikan konkret, sebut bagian dan nilai CSS-nya"]}}')
COMPARE = ("Gambar PERTAMA adalah desain referensi dari bos. Gambar TERAKHIR adalah screenshot halaman penuh website "
           "hasil kerja tim yang harus meniru referensi itu. Permintaan bos:\n{goal}\n\nBandingkan bagian per bagian "
           "dari atas ke bawah: urutan dan jumlah bagian, tata letak (kolom, posisi teks dan gambar, lebar konten), warna "
           "latar dan aksen, tipografi (ukuran, ketebalan), bentuk tombol dan kartu, foto, serta teks. Beri skor kemiripan "
           "visual 0-100 secara jujur (90 berarti hampir identik). Jawab HANYA JSON: "
           '{{"score": 0-100, "fixes": ["maks 6 perbedaan TERBESAR yang harus diubah agar mirip, masing-masing menyebut '
           'bagian, kondisi sekarang, dan target CSS/HTML yang konkret"]}}')


_IMG_URL = re.compile(r"""(?:src=|url\()["']?(https?://[^"')\s>]+)""")


async def broken_images(html: str) -> list[str]:
    """URL gambar remote di halaman yang tidak bisa dimuat (model sering mengarang id foto Unsplash)."""
    urls = list(dict.fromkeys(_IMG_URL.findall(html)))[:40]

    async def bad(client: httpx.AsyncClient, url: str) -> bool:
        try:
            r = await client.get(url, timeout=15, follow_redirects=True, headers={"Range": "bytes=0-0"})
            return r.status_code >= 400 or not r.headers.get("content-type", "").startswith("image/")
        except httpx.HTTPError:
            return True
    async with httpx.AsyncClient() as client:
        flags = await asyncio.gather(*(bad(client, u) for u in urls))
    return [u for u, f in zip(urls, flags) if f]


async def review_page(router: LLMRouter, html: Path, goal_prompt: str,
                      references: list[Path] | None = None) -> tuple[int, list[str]] | None:
    """(skor 0-100, perbaikan) untuk halaman HTML; dengan gambar referensi, skornya = kemiripan dengan referensi.
    None bila tidak bisa dinilai (tanpa Chrome atau model vision)."""
    shot = await screenshot(html)
    if shot is None:
        return None
    refs = [(p.read_bytes(), IMAGE_TYPES[p.suffix.lower()]) for p in (references or [])[:2]]
    prompt = (COMPARE if refs else REVIEW).format(goal=goal_prompt[:800])
    text = await look(router, refs + [(shot, "image/jpeg")], prompt, max_tokens=900)
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        data = json.loads(m.group(0)) if m else None
        fixes = [f if isinstance(f, str) else "; ".join(f"{k}: {v}" for k, v in f.items()) if isinstance(f, dict)
                 else str(f) for f in data.get("fixes", [])]
        return int(data["score"]), fixes[:6]
    except (ValueError, KeyError, TypeError):
        return None
