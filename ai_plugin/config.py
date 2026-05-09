from __future__ import annotations

import os
from dataclasses import dataclass


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Settings:
    db_path: str
    backend_base_url: str
    backend_jwt: "str | None"

    ai_provider: str
    ai_model: str

    openai_api_key: "str | None"
    anthropic_api_key: "str | None"
    gemini_api_key: "str | None"

    auto_fix: bool
    scheduler_enabled: bool
    scheduler_interval_minutes: int

    shared_secret: "str | None"


def get_settings() -> Settings:
    return Settings(
        db_path=os.getenv("GODAM_DB_PATH") or os.getenv("DB_PATH") or "./warehouse.db",
        backend_base_url=(os.getenv("BACKEND_BASE_URL") or "http://127.0.0.1:3001").rstrip("/"),
        backend_jwt=os.getenv("BACKEND_JWT") or None,
        ai_provider=(os.getenv("AI_PROVIDER") or "openai").strip().lower(),
        ai_model=(os.getenv("AI_MODEL") or "gpt-4.1").strip(),
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY") or None,
        gemini_api_key=os.getenv("GEMINI_API_KEY") or None,
        auto_fix=_env_bool("AUTO_FIX", False),
        scheduler_enabled=_env_bool("AI_SCHEDULER_ENABLED", False),
        scheduler_interval_minutes=max(1, int(os.getenv("AI_SCHEDULER_INTERVAL_MINUTES") or "10")),
        shared_secret=(os.getenv("AI_PLUGIN_SHARED_SECRET") or "").strip() or None,
    )

