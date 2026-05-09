import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable, Dict, List, Optional


@dataclass(frozen=True)
class DbConfig:
    path: str


class Db:
    def __init__(self, cfg: DbConfig):
        self._cfg = cfg
        self._conn = sqlite3.connect(cfg.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON;")
        self._ensure_ai_tables()

    def _ensure_ai_tables(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_action_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER,
              username TEXT,
              role TEXT,
              command TEXT,
              tool_name TEXT,
              tool_args_json TEXT,
              result_json TEXT,
              status TEXT DEFAULT 'ok',
              error_message TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_action_logs_created ON ai_action_logs(created_at DESC)"
        )
        self._conn.commit()

    def query_all(self, sql: str, params: Iterable[Any] = ()) -> List[Dict[str, Any]]:
        cur = self._conn.execute(sql, tuple(params))
        rows = cur.fetchall()
        return [dict(r) for r in rows]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> Optional[Dict[str, Any]]:
        cur = self._conn.execute(sql, tuple(params))
        row = cur.fetchone()
        return dict(row) if row else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> None:
        self._conn.execute(sql, tuple(params))
        self._conn.commit()

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

