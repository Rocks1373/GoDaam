"""
Standalone OCR microservice for GoDaam — not wired to main Node API or DB.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .routes import ocr

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

APP_ROOT = Path(__file__).resolve().parent
UPLOAD_DIR = APP_ROOT / os.getenv("UPLOAD_DIR", "uploads")
OUTPUT_DIR = APP_ROOT / os.getenv("OUTPUT_DIR", "outputs")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="GoDaam OCR Tool", version="1.0.0")

_origins = os.getenv("CORS_ORIGINS", "").strip()
if _origins:
    _list = [o.strip() for o in _origins.split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=_list, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

templates = Jinja2Templates(directory=str(APP_ROOT / "templates"))

api_prefix = os.getenv("PUBLIC_API_PREFIX", "/api/ocr").rstrip("/") or "/api/ocr"

app.include_router(ocr.router, prefix="/api/ocr", tags=["ocr"])


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "api_base": api_prefix,
        },
    )


@app.get("/ocr", response_class=HTMLResponse)
async def index_alias(request: Request):
    """Convenience path when nginx strips prefix to /ocr only."""
    return templates.TemplateResponse("index.html", {"request": request, "api_base": api_prefix})


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ocr-service-python"}
