from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Dict

import requests


@dataclass(frozen=True)
class BackendClientConfig:
    base_url: str
    jwt: Optional[str]


class BackendClient:
    """
    Optional: some dangerous actions (update status / send notification) should go through backend APIs.
    This client supports calling your existing backend with a JWT (admin user).
    """

    def __init__(self, cfg: BackendClientConfig):
        self._cfg = cfg

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._cfg.jwt:
            h["Authorization"] = f"Bearer {self._cfg.jwt}"
        return h

    def post(self, path: str, json_body: Dict[str, Any]) -> Any:
        url = self._cfg.base_url.rstrip("/") + path
        r = requests.post(url, headers=self._headers(), json=json_body, timeout=30)
        r.raise_for_status()
        return r.json()

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = self._cfg.base_url.rstrip("/") + path
        r = requests.get(url, headers=self._headers(), params=params, timeout=30)
        r.raise_for_status()
        return r.json()

