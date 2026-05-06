"""
invoice_extractor.py
====================
Robust PO / Commercial-Invoice extractor for GoDam.

Pipeline (in order):
    1. PyMuPDF text layer  (fast, lossless on born-digital PDFs)
    2. pdfplumber tables   (used for grid invoices when (1) is fragmented)
    3. OCR fallback        (pytesseract on rendered page when text layer is empty)

Returned record per invoice page:
    {
      "source_file":        str,
      "page":               int,
      "vendor":             {name, address, country},
      "customer":           {sold_to_code, ship_to_code, name, address, country},
      "invoice_number":     str,
      "invoice_date":       "YYYY-MM-DD",
      "currency":           str,
      "incoterms":          str,
      "shipment_number":    str,
      "ship_from_country":  str,
      "po_number":          str,
      "po_item":            str,
      "items": [
          {
            "order":                str,
            "order_item":           str,
            "material_id":          str,    # vendor's part number
            "customer_material_id": str,    # buyer's / GAPP part number
            "description":          str,
            "qty":                  float,
            "uom":                  str,
            "unit_price":           float,
            "net_amount":           float,
            "currency":             str,
            "country_of_origin":    str,
            "hts_code":             str,
          }, ...
      ],
      "totals": {net, vat, freight, surcharge, grand_total},
      "warnings": [str, ...],   # any field that failed validation
    }

Why not just pytesseract?
    Tesseract on a born-digital PDF loses the column structure and silently
    drops the smallest characters (the part-number suffixes you care about).
    Use OCR ONLY when there is no text layer.

Better tooling, in rough preference order:
    - PaddleOCR  (better table OCR than tesseract for scanned invoices)
    - Camelot / Tabula (when the layout is a clean ruled grid)
    - docTR      (deep-learning OCR with layout)
    - LayoutLMv3 / Donut (LLM-based, best accuracy, GPU recommended)
    - Anthropic Claude w/ "files" PDF input (zero-shot, layout-aware,
      excellent for messy multi-vendor invoices)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

import fitz                          # PyMuPDF
import pdfplumber                    # used only for table fallback
# OCR fallback (only invoked if a page has no text layer)
try:
    import pytesseract
    from PIL import Image
    _HAS_OCR = True
except ImportError:
    _HAS_OCR = False


# ---------------------------------------------------------------------------
# Regex library  (compiled once; tolerant of the spacing CommScope uses)
# ---------------------------------------------------------------------------
RX = {
    # Header
    "invoice_no":   re.compile(r"Commercial\s+Invoice\s+Number\s*\n+\s*(\d{6,})", re.I),
    "invoice_date": re.compile(r"Commercial\s+Invoice\s+Date\s*\n+\s*([0-3]?\d\s+[A-Z]{3}\s+\d{4})", re.I),
    "incoterms":    re.compile(r"Incoterms\s*\n+\s*([A-Z&/ ]+?)(?=\n)", re.I),
    "ship_from":    re.compile(r"([A-Z]{2})\s*\nShip From Country", re.I),
    "shipment":     re.compile(r"(\d{6,})\s*\nShipment Number", re.I),
    "currency":     re.compile(r"\b(USD|EUR|SAR|GBP|AED)\b"),

    # Sold-to / ship-to
    "sold_to":      re.compile(r"Sold To\s*:\s*(\d+)\s*\n([\s\S]+?)\n\s*Ship To\s*:", re.I),
    "ship_to":      re.compile(r"Ship To\s*:\s*(\d+)\s*\n([\s\S]+?)\n\s*Freight Forwarder\s*:", re.I),
    "exporter":     re.compile(r"Exporter\s*\n([\s\S]+?)\n\s*Terms and Conditions", re.I),

    # Per-item anchor — each line item starts with "Purchase Order :"
    # The fields below it can appear in different orders on different invoices.
    "po_anchor":    re.compile(r"Purchase Order\s*:\s*(?P<po>\S+)", re.I),
    "po_item_kv":   re.compile(r"Purchase Order Item\s*:\s*(?P<po_item>\S+)", re.I),
    "coo_kv":       re.compile(r"Country Of Origin\s*:\s*(?P<coo>[A-Z]{2})", re.I),
    "hts_kv":       re.compile(r"HTS Code\s*:\s*(?P<hts>\S+)", re.I),
    "eccn_kv":      re.compile(r"ECCN No\s*:\s*(?P<eccn>\S+)", re.I),
    "license_kv":   re.compile(r"License No\s*:\s*(?P<lic>\S+)", re.I),
    "pref_kv":      re.compile(r"Preference\s*:\s*(?P<pref>\S+)", re.I),

    # Numbers
    "amount":       re.compile(r"-?\d[\d,]*\.\d{2}"),
    "qty_or_price": re.compile(r"-?\d[\d,]*\.\d+"),
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class Address:
    code: str = ""
    name: str = ""
    address: str = ""
    country: str = ""


@dataclass
class LineItem:
    order: str = ""
    order_item: str = ""
    material_id: str = ""
    customer_material_id: str = ""
    description: str = ""
    qty: float = 0.0
    uom: str = ""
    unit_price: float = 0.0
    net_amount: float = 0.0
    currency: str = ""
    country_of_origin: str = ""
    hts_code: str = ""


@dataclass
class InvoiceRecord:
    source_file: str = ""
    page: int = 0
    vendor: Address = field(default_factory=Address)
    customer: Address = field(default_factory=Address)
    ship_to: Address = field(default_factory=Address)
    invoice_number: str = ""
    invoice_date: str = ""
    currency: str = ""
    incoterms: str = ""
    shipment_number: str = ""
    ship_from_country: str = ""
    po_number: str = ""
    po_item: str = ""
    items: list[LineItem] = field(default_factory=list)
    totals: dict[str, float] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_MONTH = {
    "JAN": "01", "FEB": "02", "MAR": "03", "APR": "04",
    "MAY": "05", "JUN": "06", "JUL": "07", "AUG": "08",
    "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
}


def _to_iso_date(s: str) -> str:
    """'02 FEB 2026' -> '2026-02-02'."""
    m = re.match(r"(\d{1,2})\s+([A-Z]{3})\s+(\d{4})", s.strip(), re.I)
    if not m:
        return s
    d, mon, y = m.groups()
    return f"{y}-{_MONTH.get(mon.upper(), mon)}-{int(d):02d}"


def _to_float(s: str) -> float:
    try:
        return float(s.replace(",", "").strip())
    except (ValueError, AttributeError):
        return 0.0


def _normalize(text: str) -> str:
    """Collapse runs of blank lines but keep single newlines (positions matter)."""
    return re.sub(r"\n[ \t]*\n+", "\n", text).strip()


def _ocr_page(page: fitz.Page) -> str:
    if not _HAS_OCR:
        return ""
    pix = page.get_pixmap(dpi=300)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return pytesseract.image_to_string(img, config="--oem 1 --psm 6")


# ---------------------------------------------------------------------------
# Page parser
# ---------------------------------------------------------------------------
def _parse_page(raw_text: str, page_num: int, source: Path) -> InvoiceRecord:
    text = _normalize(raw_text)
    rec = InvoiceRecord(source_file=str(source), page=page_num)

    def grab(rx_key: str, default: str = "") -> str:
        m = RX[rx_key].search(text)
        return m.group(1).strip() if m else default

    # --- Header ----------------------------------------------------------
    rec.invoice_number    = grab("invoice_no")
    rec.invoice_date      = _to_iso_date(grab("invoice_date"))
    rec.incoterms         = grab("incoterms")
    rec.ship_from_country = grab("ship_from")
    rec.shipment_number   = grab("shipment")

    # currency: take the first occurrence after totals block
    m = RX["currency"].search(text)
    if m:
        rec.currency = m.group(1)

    # --- Sold-to / ship-to / exporter ------------------------------------
    if (m := RX["sold_to"].search(text)):
        rec.customer = _block_to_addr(m.group(1), m.group(2))
    if (m := RX["ship_to"].search(text)):
        rec.ship_to  = _block_to_addr(m.group(1), m.group(2))
    if (m := RX["exporter"].search(text)):
        block = m.group(1).strip().splitlines()
        rec.vendor = Address(
            name    = block[0] if block else "",
            address = ", ".join(b.strip() for b in block[1:-1]) if len(block) > 2 else "",
            country = block[-1].strip() if len(block) > 1 else "",
        )

    # --- PO + line items -------------------------------------------------
    # Split text on every "Purchase Order :" line; each PRECEDING segment
    # is the item table for that PO line, the FOLLOWING short region is the
    # meta block (ECCN/License/Country/HTS/Preference, in any order).
    items, po_meta = _split_into_items(text)
    if items:
        rec.po_number = po_meta[0].get("po", "")
        rec.po_item   = po_meta[0].get("po_item", "")
        rec.items = items

    # --- Totals ----------------------------------------------------------
    rec.totals = _extract_totals(text)

    # --- Validation ------------------------------------------------------
    _validate(rec)
    return rec


def _block_to_addr(code: str, block: str) -> Address:
    lines = [ln.strip() for ln in block.strip().splitlines() if ln.strip()]
    return Address(
        code    = code,
        name    = lines[0] if lines else "",
        address = ", ".join(lines[1:-1]) if len(lines) > 2 else "",
        country = lines[-1] if len(lines) > 1 else "",
    )


def _split_into_items(text: str) -> tuple[list[LineItem], list[dict[str, str]]]:
    """
    Parse every line item on the page.

    The CommScope text stream is laid out so each item's table cells appear
    BEFORE its 'Purchase Order :' line, and its meta fields (ECCN, License,
    Country, HTS, Preference, Description) appear AFTER. We split on the
    'Purchase Order :' anchor and pair each preceding segment with its
    following meta block.
    """
    items: list[LineItem] = []
    meta_out: list[dict[str, str]] = []

    # Find every "Purchase Order :" anchor
    anchors = list(RX["po_anchor"].finditer(text))
    if not anchors:
        return items, meta_out

    # The "table region" starts after "Terms and Conditions" line
    table_start = 0
    m_terms = re.search(r"Terms and Conditions[^\n]*\n", text)
    if m_terms:
        table_start = m_terms.end()

    prev_table_start = table_start
    for i, anchor in enumerate(anchors):
        # ----- Cells (everything between previous boundary and this anchor) ----
        cell_block = text[prev_table_start:anchor.start()].strip()

        # ----- Meta block (between this anchor and the next, or end of page) ---
        next_start = anchors[i + 1].start() if i + 1 < len(anchors) else len(text)
        meta_block = text[anchor.start():next_start]

        item = _parse_item_cells(cell_block)
        meta = _parse_meta_block(meta_block)

        item.country_of_origin = meta.get("coo", "")
        item.hts_code          = meta.get("hts", "")
        item.description       = meta.get("description", "")

        # Skip empty items produced by trailing whitespace splits
        if item.material_id or item.customer_material_id \
                or item.qty or item.unit_price or item.net_amount:
            items.append(item)
            meta_out.append(meta)

        # next item's table cells start at the end of THIS meta block
        prev_table_start = _meta_end(meta_block, anchor.start())

    return items, meta_out


def _meta_end(meta_block: str, anchor_offset: int) -> int:
    """Return absolute offset where the meta block (description) ends and
    the next item's table cells begin."""
    # 1) tariff disclaimer always marks end-of-item when it appears
    m = re.search(r"This tariff classification[^\n]*\n?", meta_block)
    if m:
        return anchor_offset + m.end()
    # 2) intermediate items: end where the next item's UOM+price pattern starts
    m = re.search(r"\n([A-Z]{1,3}\n\d[\d,]*\.\d)", meta_block)
    if m:
        return anchor_offset + m.start() + 1   # +1 to skip the leading \n
    return anchor_offset + len(meta_block)


def _parse_item_cells(block: str) -> LineItem:
    """
    Parse the table cell block for ONE line item. CommScope dumps the cells
    in this order in the text stream:
        UOM, UnitPrice, Qty, UOM, CustomerMaterialID, MaterialID,
        OrderItem(000xxx), Order(7-digit), NetAmount
    """
    item = LineItem()
    lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
    if not lines:
        return item

    # Walk lines and bucket by pattern.
    nums: list[str] = []
    alphanum_ids: list[str] = []  # anything that looks like a part-number SKU
    for ln in lines:
        if re.fullmatch(r"-?\d[\d,]*\.\d{2}", ln):                # amount
            nums.append(ln)
        elif re.fullmatch(r"-?\d[\d,]*\.\d+", ln):                # decimal
            nums.append(ln)
        elif re.fullmatch(r"\d{1,7}", ln) and not item.order_item \
                and not item.order and len(nums) >= 1 and len(nums) < 3:
            # plausible integer qty between unit_price and net_amount
            nums.append(ln)
        elif re.fullmatch(r"[A-Z]{1,3}", ln) and not item.uom:
            item.uom = ln
        elif re.fullmatch(r"\d{9,}", ln) and not item.material_id:
            # 9+ digit numeric SAP material id
            item.material_id = ln
        elif re.fullmatch(r"0{2,}\d{2,}", ln) and not item.order_item:
            item.order_item = ln
        elif re.fullmatch(r"\d{7}", ln) and not item.order:
            item.order = ln
        elif re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9\-/.]{3,}", ln) \
                and not ln.replace(",", "").replace(".", "").isdigit() \
                and ln != item.uom:
            alphanum_ids.append(ln)

    # Two part-number columns appear in stream order: customer_material_id, material_id.
    # If the SAP material_id (numeric) was already filled, the alphanums map to
    # customer first, leftover -> material. If material_id is empty, alphanums
    # take both slots: customer first, then material.
    if alphanum_ids:
        item.customer_material_id = alphanum_ids[0]
        if len(alphanum_ids) > 1 and not item.material_id:
            item.material_id = alphanum_ids[1]

    # nums (in stream order): [unit_price, qty, net_amount]
    if len(nums) >= 3:
        item.unit_price = _to_float(nums[0])
        item.qty        = _to_float(nums[1])
        item.net_amount = _to_float(nums[-1])
    elif len(nums) == 2:
        item.unit_price = _to_float(nums[0])
        item.qty        = _to_float(nums[1])
    elif len(nums) == 1:
        item.net_amount = _to_float(nums[0])

    # Swap if heuristic put numeric ID into customer_material_id by mistake
    if item.customer_material_id.isdigit() and item.material_id \
            and not item.customer_material_id.startswith("000"):
        item.customer_material_id, item.material_id = item.material_id, item.customer_material_id

    return item


def _parse_meta_block(block: str) -> dict[str, str]:
    """Parse the per-item meta block — fields can appear in any order."""
    meta: dict[str, str] = {}
    for key, rx_key in [
        ("po", "po_anchor"), ("po_item", "po_item_kv"),
        ("coo", "coo_kv"),   ("hts", "hts_kv"),
        ("eccn", "eccn_kv"), ("license", "license_kv"),
        ("preference", "pref_kv"),
    ]:
        m = RX[rx_key].search(block)
        if m:
            meta[key] = m.group(1).strip()

    # Description: the line(s) between "Preference : XX" and EITHER:
    #   - "This tariff" disclaimer (last item on the page), OR
    #   - the start of the NEXT item's table cells (a UOM token followed by a
    #     decimal price, e.g. "\nEA\n21.23026").
    m = re.search(
        r"Preference\s*:\s*\S+\s*\n+(?P<desc>[\s\S]+?)"
        r"(?=\nThis tariff|\n[A-Z]{1,3}\n\d[\d,]*\.\d|\Z)",
        block, re.I,
    )
    if m:
        meta["description"] = " ".join(m.group("desc").split())
    return meta


def _extract_totals(text: str) -> dict[str, float]:
    """
    The footer totals row appears as a vertical run of numbers between
    'Inv. Currency' and the currency code. Order is:
        freight, vat, material_total, surcharge, invoice_total
    """
    m = re.search(r"Inv\.\s*Currency[\s\S]+?(USD|EUR|SAR|GBP|AED)", text, re.I)
    if not m:
        return {}
    block = text[m.start():m.end()]
    nums = RX["amount"].findall(block)
    if len(nums) < 5:
        return {"grand_total": _to_float(nums[-1])} if nums else {}
    return {
        "freight":        _to_float(nums[0]),
        "vat":            _to_float(nums[1]),
        "material_total": _to_float(nums[2]),
        "surcharge":      _to_float(nums[3]),
        "grand_total":    _to_float(nums[4]),
    }


# ---------------------------------------------------------------------------
# Validation: never silently drop a required field
# ---------------------------------------------------------------------------
REQUIRED = {
    "invoice_number":   "Invoice number missing",
    "invoice_date":     "Invoice date missing",
    "po_number":        "PO number missing",
}


def _validate(rec: InvoiceRecord) -> None:
    for k, msg in REQUIRED.items():
        if not getattr(rec, k):
            rec.warnings.append(msg)
    if not rec.items:
        rec.warnings.append("No line items detected")
    for i, it in enumerate(rec.items):
        if not it.material_id and not it.customer_material_id:
            rec.warnings.append(f"item[{i}]: part number missing")
        if it.qty <= 0:
            rec.warnings.append(f"item[{i}]: qty <= 0")
        if it.unit_price <= 0:
            rec.warnings.append(f"item[{i}]: unit_price <= 0")
        if it.qty and it.unit_price:
            expected = round(it.qty * it.unit_price, 2)
            if abs(expected - it.net_amount) > 0.05:
                rec.warnings.append(
                    f"item[{i}]: qty*price={expected} != net_amount={it.net_amount}"
                )
        if not it.uom:
            rec.warnings.append(f"item[{i}]: UOM missing")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def extract_pdf(path: str | Path) -> list[dict[str, Any]]:
    """
    Extract every invoice page in `path`. Returns a list of records (one per page).
    Falls back to OCR ONLY for pages with no text layer.
    """
    path = Path(path)
    out: list[dict[str, Any]] = []
    with fitz.open(path) as doc:
        for i, page in enumerate(doc, start=1):
            text = page.get_text()
            if len(text.strip()) < 50:
                # likely scanned -> OCR fallback
                text = _ocr_page(page)
            rec = _parse_page(text, i, path)
            out.append(rec.to_dict())
    return out


def extract_to_json(path: str | Path, out_json: str | Path) -> None:
    records = extract_pdf(path)
    Path(out_json).write_text(json.dumps(records, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: python invoice_extractor.py <input.pdf> [output.json]")
        raise SystemExit(2)

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix(".json")
    extract_to_json(src, dst)

    data = json.loads(Path(dst).read_text())
    issues = sum(len(r["warnings"]) for r in data)
    print(f"✓ {len(data)} pages extracted -> {dst}")
    print(f"  {sum(len(r['items']) for r in data)} line items, {issues} warnings")
    for r in data:
        if r["warnings"]:
            print(f"  page {r['page']}: {r['warnings']}")
