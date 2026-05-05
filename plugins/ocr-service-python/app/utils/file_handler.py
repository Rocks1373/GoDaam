import os
import re
import uuid
from pathlib import Path


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def safe_filename(name: str) -> str:
    base = os.path.basename(name or "upload")
    base = re.sub(r"[^a-zA-Z0-9._-]", "_", base)[:180]
    return base or "upload"


def save_upload(content: bytes, original_name: str, upload_dir: Path) -> tuple[str, Path]:
    """Returns (file_id, absolute_path)."""
    ensure_dir(upload_dir)
    fid = str(uuid.uuid4())
    ext = Path(original_name).suffix.lower() or ".bin"
    if ext not in {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff"}:
        ext = ".bin"
    dest = upload_dir / f"{fid}{ext}"
    dest.write_bytes(content)
    return fid, dest.resolve()


def is_pdf(path: Path) -> bool:
    return path.suffix.lower() == ".pdf"


def is_image(path: Path) -> bool:
    return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff"}
