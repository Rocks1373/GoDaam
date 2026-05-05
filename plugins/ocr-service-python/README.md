# GoDaam — Standalone OCR Tool (Python)

Simple warehouse-facing OCR: upload a PDF or image, click **Extract Data**, edit fields, export Excel or copy JSON. **Not** connected to the main GoDaam Node API or SQLite database.

## Stack

- **FastAPI** + Jinja2 single-page UI  
- **pdfplumber** for text-layer PDFs  
- **PyMuPDF (fitz)** to rasterize pages when the PDF has almost no text (scanned)  
- **pytesseract** for images and rasterized PDF pages  
- **pandas** + **openpyxl** for Excel export  

Install **Tesseract OCR** on the host (e.g. `brew install tesseract` on macOS, `apt install tesseract-ocr` on Debian/Ubuntu).

## Run locally

```bash
cd plugins/ocr-service-python
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 0.0.0.0 --port 8090
```

Open **http://127.0.0.1:8090/** — API base for the page defaults to **`/api/ocr`** (direct access).

## Deploy behind Nginx (`/ocr/`)

1. Run the service on **port 8090** (or change `PORT` and proxy target).  
2. Add a location block — see **`nginx-ocr-location.conf.example`**.  
3. Set in **`.env`**:

```env
PUBLIC_API_PREFIX=/ocr/api/ocr
```

So the browser calls `https://your-domain/ocr/api/ocr/upload`, which Nginx forwards to `http://127.0.0.1:8090/api/ocr/upload`.

## Connect with GoDaam web app

The main frontend includes an **“OCR Tool”** sidebar link. By default it opens:

`https://godam.divadivya.cloud/ocr`

Override with Vite env (e.g. repo root or `frontend/.env.local`):

```env
VITE_OCR_TOOL_URL=https://your-host/ocr/
```

No backend or database integration is required. Later you can POST the copied JSON to a GoDaam endpoint if you add one.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ocr/upload` | multipart `file` → `{ file_id, filename, stored_as }` |
| `POST` | `/api/ocr/extract` | JSON `{ "file_id": "<uuid>" }` → `{ header, items, raw_text_preview }` |
| `POST` | `/api/ocr/export-excel` | JSON `{ "header": {...}, "items": [...] }` → `.xlsx` download |
| `GET` | `/health` | `{ "status": "ok" }` |

Uploaded files are tracked **in memory** (`file_id` → path); restart clears them.

## Limitations

- Heuristic header/table parsing only — layout varies by vendor; staff should **verify** before relying on exports.  
- No field-mapping UI, anchors, or stock/DN updates.  
- Large PDFs: first **3** pages are OCR’d when the text layer is empty.  
- Max upload **30 MB** (see `routes/ocr.py`).

## Future upgrade (optional)

For higher-quality layout OCR on a **GPU server**, you could run [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) as a separate service and replace or supplement `extractor.py` — still keep this service as a thin HTTP front for warehouse staff.

## License

Same as parent GoDaam repository unless you specify otherwise.
