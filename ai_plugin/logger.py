from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Optional, Dict

from .db import Db


@dataclass
class AiLogEntry:
    user_id: Optional[int]
    username: Optional[str]
    role: Optional[str]
    command: Optional[str]
    tool_name: Optional[str]
    tool_args: Optional[Dict[str, Any]]
    result: Optional[Any]
    status: str
    error_message: Optional[str] = None
    created_at_epoch_ms: Optional[int] = None


def now_ms() -> int:
    return int(time.time() * 1000)


def safe_json_dumps(obj: Any) -> str:
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return json.dumps({"unserializable": str(obj)}, ensure_ascii=False)


class ActionLogger:
    def __init__(self, db: Db):
        self._db = db

    def log(self, entry: AiLogEntry) -> None:
        ts_ms = entry.created_at_epoch_ms or now_ms()
        self._db.execute(
            """
            INSERT INTO ai_action_logs
              (user_id, username, role, command, tool_name, tool_args_json, result_json, status, error_message, created_at)
            VALUES
              (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(? / 1000, 'unixepoch'))
            """,
            (
                entry.user_id,
                entry.username,
                entry.role,
                entry.command,
                entry.tool_name,
                safe_json_dumps(entry.tool_args) if entry.tool_args is not None else None,
                safe_json_dumps(entry.result) if entry.result is not None else None,
                entry.status,
                entry.error_message,
                ts_ms,
            ),
        )

