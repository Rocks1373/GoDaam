from __future__ import annotations

from pathlib import Path
from typing import Any

import fitz  # PyMuPDF

from .ai_cleanup import cleanup_low_confidence
from .confidence import annotate
from .dedupe import mark_duplicates
from .models import InvoiceRecord
from .ocr import has_ocr, ocr_pixmap
from .parsers import detect_parser
from .parsers.base import ParserContext

_OCR_TEXT_THRESHOLD = 50


def extract_text(page: fitz.Page) -> tuple[str, str]:
    """Return (text, method). Falls back to OCR when text layer is empty."""
    text = page.get_text() or ""
    if len(text.strip()) >= _OCR_TEXT_THRESHOLD:
        return text, "text"
    if has_ocr():
        pix = page.get_pixmap(dpi=300)
        return ocr_pixmap(pix.width, pix.height, pix.samples), "ocr"
    return text, "text"


def extract_pdf(
    path: str | Path,
    *,
    forced_vendor: str | None = None,
    ai_cleanup: bool = False,
    ai_threshold: int = 70,
) -> list[dict[str, Any]]:
    """Extract every page of `path` and return a list of records (one per page)."""
    path = Path(path)
    records: list[InvoiceRecord] = []
    raw_segments_per_record: list[list[str]] = []

    with fitz.open(path) as doc:
        for i, page in enumerate(doc, start=1):
            text, method = extract_text(page)
            parser = detect_parser(text, forced=forced_vendor)
            ctx = ParserContext(source=path, page=i, extraction_method=method)
            rec, segments = parser.parse(text, ctx)
            records.append(rec)
            raw_segments_per_record.append(segments)

    for rec in records:
        annotate(rec)

    mark_duplicates(records)

    if ai_cleanup:
        for rec, segs in zip(records, raw_segments_per_record):
            n = cleanup_low_confidence(rec, segs, threshold=ai_threshold)
            if n:
                annotate(rec)  # rescore after cleanup

    return [r.to_dict() for r in records]
