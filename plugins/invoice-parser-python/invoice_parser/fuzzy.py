from __future__ import annotations

try:
    from rapidfuzz import fuzz, process
    _HAS_RAPIDFUZZ = True
except ImportError:
    _HAS_RAPIDFUZZ = False


def best_match(query: str, choices: list[str], threshold: int = 85) -> tuple[str, int] | None:
    if not query or not choices or not _HAS_RAPIDFUZZ:
        return None
    hit = process.extractOne(query, choices, scorer=fuzz.WRatio)
    if hit and hit[1] >= threshold:
        return (hit[0], int(hit[1]))
    return None


def similar(a: str, b: str) -> int:
    if not _HAS_RAPIDFUZZ:
        return 100 if a == b else 0
    return int(fuzz.WRatio(a, b))
