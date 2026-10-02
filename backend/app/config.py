import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")


@dataclass(frozen=True)
class Settings:
    supervisor_token: str = os.getenv("SUPERVISOR_TOKEN", "dev-token")
    database_path: str = os.getenv("DATABASE_PATH", str(BASE_DIR.parent / "data" / "cyberverse.db"))
    chroma_path: str = os.getenv("CHROMA_PATH", str(BASE_DIR.parent / "data" / "chroma"))
    workspace_path: str = os.getenv("WORKSPACE_PATH", str(BASE_DIR.parent / "workspace"))
    llm_limits_path: str = os.getenv("LLM_LIMITS_PATH", str(BASE_DIR / "config" / "llm_limits.yaml"))
    agents_path: str = os.getenv("AGENTS_PATH", str(BASE_DIR / "config" / "agents.yaml"))
    frontend_origins: list[str] = field(
        default_factory=lambda: os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").split(",")
    )
    demo_mode: bool = os.getenv("DEMO_MODE", "0") == "1"
    max_active_agents: int = int(os.getenv("MAX_ACTIVE_AGENTS", "6"))


settings = Settings()
