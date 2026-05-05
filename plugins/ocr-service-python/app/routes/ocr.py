from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from ..services.extractor import extract_all
from ..utils.file_handler import is_image, is_pdf, save_upload

router = APIRouter()

# In-memory store: file_id -> absolute Path (no DB)
_file_registry: dict[str, Path] = {}


def _register(path: Path, fid: str) -> None:
    _file_registry[fid] = path


def _resolve_path(file_id: str) -> Path:
    p = _file_registry.get(file_id)
    if not p or not p.is_file():
        raise HTTPException(status_code=404, detail="Unknown or expired file_id. Upload again.")
    return p


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    content = await file.read()
    if len(content) > 30 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 30 MB)")
    upload_dir = Path(__file__).resolve().parent.parent / "uploads"
    fid, dest = save_upload(content, file.filename, upload_dir)
    _register(dest, fid)
    return {"file_id": fid, "filename": file.filename, "stored_as": str(dest.name)}


@router.post("/extract")
async def extract(payload: dict[str, Any]):
    file_id = payload.get("file_id") or payload.get("path")
    if not file_id:
        raise HTTPException(400, "file_id required")
    if isinstance(file_id, dict):
        raise HTTPException(400, "Invalid body")
    path = _resolve_path(str(file_id))
    if not (is_pdf(path) or is_image(path)):
        raise HTTPException(400, "Only PDF or image files supported")
    data = extract_all(path)
    return JSONResponse(data)


@router.post("/export-excel")
async def export_excel(payload: dict[str, Any]):
    header = payload.get("header") or {}
    items = payload.get("items") or []
    if not isinstance(header, dict):
        raise HTTPException(400, "header must be an object")
    if not isinstance(items, list):
        raise HTTPException(400, "items must be a list")

    h_df = pd.DataFrame([{"field": k, "value": v} for k, v in header.items()])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        h_df.to_excel(writer, sheet_name="Header", index=False)
        i_df = pd.DataFrame(items)
        if i_df.empty:
            i_df = pd.DataFrame(columns=["part_number", "description", "qty"])
        i_df.to_excel(writer, sheet_name="Items", index=False)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="ocr-export.xlsx"'},
    )