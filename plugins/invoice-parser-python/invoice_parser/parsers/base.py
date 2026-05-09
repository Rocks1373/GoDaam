from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from ..models import InvoiceRecord


@dataclass
class ParserContext:
    source: Path
    page: int
    extraction_method: str = "text"


class BaseInvoiceParser(ABC):
    """Vendor-specific invoice parser.

    Subclasses implement document fingerprinting and per-page parsing.
    """

    name: str = "base"
    vendor: str = ""

    @classmethod
    @abstractmethod
    def fingerprint(cls, text: str) -> bool:
        """Return True if `text` looks like this vendor's invoice."""

    @abstractmethod
    def parse(self, text: str, ctx: ParserContext) -> tuple[InvoiceRecord, list[str]]:
        """Parse one page of text. Returns (record, raw_segments_per_item) for AI cleanup."""
