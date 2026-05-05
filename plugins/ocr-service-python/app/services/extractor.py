"""
Extract plain text from PDF (text layer) or image / scanned pages via Tesseract.
"""
from __future__ import annotations

from pathlib import Path

import fitz  # PyMuPDF
import pdfplumber
import pytesseract
from PIL import Image

from .parser import extract_header, extract_table, normalize_text


def _pdf_text_pdfplumber(path: Path) -> str:
    chunks: list[str] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ""
            if t.strip():
                chunks.append(t)
    return "\n".join(chunks)


def _ocr_image_pil(img: Image.Image) -> str:
    return pytesseract.image_to_string(img.convert("RGB"), lang="eng") or ""


def _pdf_raster_ocr(path: Path, max_pages: int = 3) -> str:
    """Rasterize first pages and OCR (for scanned PDFs)."""
    doc = fitz.open(path)
    out: list[str] = []
    try:
        for i in range(min(len(doc), max_pages)):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            out.append(_ocr_image_pil(img))
    finally:
        doc.close()
    return "\n".join(out)


def extract_text_from_file(path: Path) -> str:
    suf = path.suffix.lower()
    if suf == ".pdf":
        text = _pdf_text_pdfplumber(path)
        compact = "".join(text.split())
        if len(compact) < 80:
            text = _pdf_raster_ocr(path)
        return text
    if suf in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff"}:
        img = Image.open(path)
        return _ocr_image_pil(img)
    return ""


def extract_all(path: Path) -> dict:
    raw = extract_text_from_file(path)
    lines = normalize_text(raw)
    header = extract_header(raw)
    items = extract_table(lines)
    return {"header": header, "items": items, "raw_text_preview": raw[:8000]}
