from __future__ import annotations

from .base import BaseInvoiceParser
from .commscope import CommScopeParser

REGISTRY: list[type[BaseInvoiceParser]] = [
    CommScopeParser,
]


def detect_parser(text: str, forced: str | None = None) -> BaseInvoiceParser:
    """Return a parser instance for `text`. Falls back to the first registered parser."""
    if forced:
        for cls in REGISTRY:
            if cls.name == forced or cls.vendor.lower() == forced.lower():
                return cls()
    for cls in REGISTRY:
        if cls.fingerprint(text):
            return cls()
    return REGISTRY[0]()
