"""
Simple heuristic header + table parsing — no mapping UI, warehouse-friendly defaults.
"""
from __future__ import annotations

import re
from typing import Any


def normalize_text(raw: str) -> list[str]:
    lines = []
    for line in (raw or "").splitlines():
        s = re.sub(r"[ \t]+", " ", line).strip()
        if s:
            lines.append(s)
    return lines


def _line_after_label(lines: list[str], label_substrings: tuple[str, ...]) -> str:
    for i, line in enumerate(lines):
        low = line.lower()
        if any(sub in low for sub in label_substrings):
            if ":" in line:
                parts = line.split(":", 1)
                if len(parts) > 1 and parts[1].strip():
                    return parts[1].strip()
            if i + 1 < len(lines):
                return lines[i + 1].strip()
    return ""


def extract_header(text: str) -> dict[str, str]:
    lines = normalize_text(text)
    joined = "\n".join(lines)

    header: dict[str, str] = {
        "invoice_number": "",
        "date": "",
        "po_number": "",
        "vendor": "",
        "customer": "",
    }

    # Label-based (same line after colon, or next line)
    inv = _line_after_label(lines, ("invoice", "commercial invoice"))
    if inv:
        header["invoice_number"] = inv
    date_v = _line_after_label(lines, ("date", "invoice date", "commercial invoice date"))
    if date_v:
        header["date"] = date_v
    po = _line_after_label(lines, ("po number", "p.o.", "purchase order", " po", "customer po"))
    if po:
        header["po_number"] = po
    vendor = _line_after_label(lines, ("vendor", "supplier", "sold-by", "sold by"))
    if vendor:
        header["vendor"] = vendor
    customer = _line_after_label(lines, ("customer", "ship to", "bill to", "consignee"))
    if customer:
        header["customer"] = customer

    # Regex fallbacks if still empty
    if not header["invoice_number"]:
        m = re.search(r"(?:invoice|inv\.?)\s*#?\s*[:\s]*(\d{6,})", joined, re.I)
        if m:
            header["invoice_number"] = m.group(1).strip()
        else:
            m2 = re.search(r"\b(\d{8,12})\b", joined)
            if m2:
                header["invoice_number"] = m2.group(1)

    if not header["date"]:
        m = re.search(
            r"\b(\d{1,2}[-/ ]\w+[-/ ]\d{2,4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b",
            joined,
            re.I,
        )
        if m:
            header["date"] = m.group(1).strip()

    if not header["po_number"]:
        m = re.search(r"(?:PO|P\.O\.)\s*#?\s*[:\s]*(\d{5,})", joined, re.I)
        if m:
            header["po_number"] = m.group(1).strip()
        else:
            m2 = re.search(r"\b(\d{10})\b", joined)
            if m2:
                header["po_number"] = m2.group(1)

    return header


def _split_row(line: str) -> list[str]:
    if "\t" in line:
        return [c.strip() for c in line.split("\t") if c.strip()]
    parts = re.split(r"\s{2,}", line)
    return [p.strip() for p in parts if p.strip()]


def extract_table(lines: list[str]) -> list[dict[str, Any]]:
    """Find header row with Part/Qty/Description then parse following lines."""
    idx = -1
    header_tokens = ("part", "qty", "description", "material", "item")
    for i, line in enumerate(lines):
        low = line.lower()
        hits = sum(1 for t in header_tokens if t in low)
        if hits >= 2 or ("part" in low and "qty" in low) or ("material" in low and "description" in low):
            idx = i
            break
    if idx < 0:
        return []

    items: list[dict[str, Any]] = []
    for line in lines[idx + 1 :]:
        if not line.strip() or re.match(r"^[-_=]+$", line):
            continue
        if any(x in line.lower() for x in ("total", "net value", "grand total", "footer")):
            break
        cells = _split_row(line)
        if len(cells) < 2:
            continue
        part = cells[0]
        desc = cells[1] if len(cells) > 1 else ""
        qty = cells[2] if len(cells) > 2 else ""
        items.append({"part_number": part, "description": desc, "qty": qty})
    return items
