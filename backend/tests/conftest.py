import pytest_asyncio

from app.db.repo import Repo


@pytest_asyncio.fixture
async def repo(tmp_path):
    """Repo di DB sementara; selalu ditutup (koneksi aiosqlite yang terbuka menahan proses pytest)."""
    r = await Repo.open(str(tmp_path / "t.db"))
    yield r
    await r.close()
