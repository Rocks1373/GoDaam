from __future__ import annotations

import re

_MONTH = {
    "JAN": "01", "FEB": "02", "MAR": "03", "APR": "04",
    "MAY": "05", "JUN": "06", "JUL": "07", "AUG": "08",
    "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
}

_OCR_DIGIT_FIX = str.maketrans({"O": "0", "o": "0", "l": "1", "I": "1", "S": "5", "B": "8"})


def collapse_blank_lines(text: str) -> str:
    return re.sub(r"\n[ \t]*\n+", "\n", text).strip()


def collapse_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def to_iso_date(s: str) -> str:
    if not s:
        return ""
    m = re.match(r"(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})", s.strip())
    if not m:
        return s.strip()
    d, mon, y = m.groups()
    return f"{y}-{_MONTH.get(mon.upper(), mon)}-{int(d):02d}"


def to_float(s: str | float | int) -> float:
    if isinstance(s, (int, float)):
        return float(s)
    if not s:
        return 0.0
    try:
        return float(str(s).replace(",", "").strip())
    except (ValueError, AttributeError):
        return 0.0


def fix_ocr_digits(s: str) -> str:
    """Apply OCR-confusable character correction. Use ONLY on fields that must be numeric."""
    return s.translate(_OCR_DIGIT_FIX)


def looks_numeric_id(s: str) -> bool:
    return bool(re.fullmatch(r"\d{6,}", s))


def looks_partnumber(s: str) -> bool:
    if not s or len(s) < 4:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\-/.]{3,}", s))
