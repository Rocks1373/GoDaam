import threading
import time
from dataclasses import dataclass
from typing import Optional

import schedule

from .tools import ToolContext, generate_report


@dataclass(frozen=True)
class SchedulerConfig:
    interval_minutes: int


class OrderCheckerScheduler:
    def __init__(self, ctx: ToolContext, cfg: SchedulerConfig):
        self._ctx = ctx
        self._cfg = cfg
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        schedule.clear()
        schedule.every(self._cfg.interval_minutes).minutes.do(self._job)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            schedule.run_pending()
            time.sleep(1)

    def _job(self) -> None:
        # Report only. AUTO_FIX is handled by tools (dangerous tools still gated).
        generate_report(self._ctx, report_type="gapp_confirmation_issue_report", limit=200)
        generate_report(self._ctx, report_type="notification_failure_report", limit=200)

