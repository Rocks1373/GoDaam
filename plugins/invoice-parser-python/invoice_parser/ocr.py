from __future__ import annotations

try:
    import pytesseract
    from PIL import Image
    _HAS_OCR = True
except ImportError:
    _HAS_OCR = False


def ocr_pixmap(width: int, height: int, samples: bytes) -> str:
    if not _HAS_OCR:
        return ""
    img = Image.frombytes("RGB", (width, height), samples)
    return pytesseract.image_to_string(img, config="--oem 1 --psm 6")


def has_ocr() -> bool:
    return _HAS_OCR
