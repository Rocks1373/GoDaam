from __future__ import annotations

import re

from ..models import Address, InvoiceRecord, LineItem
from ..normalize import collapse_whitespace, to_float, to_iso_date
from .base import BaseInvoiceParser, ParserContext


# ---------------------------------------------------------------------------
# Header regex (PyMuPDF outputs labels and values on alternating lines)
# ---------------------------------------------------------------------------
RX_INVOICE_NO   = re.compile(r"Commercial Invoice Number\s*\n\s*(\d{6,})", re.I)
RX_INVOICE_DT   = re.compile(r"Commercial Invoice Date\s*\n\s*([0-3]?\d\s+[A-Za-z]{3}\s+\d{4})", re.I)
RX_INCOTERMS    = re.compile(r"\nIncoterms\s*\n\s*([^\n]+?)\s*\n", re.I)
RX_SHIPMENT     = re.compile(r"\n(\d{6,})\s*\nShipment Number\b", re.I)
RX_SHIP_FROM    = re.compile(r"\n([A-Z]{2})\s*\nShip From Country\b", re.I)
RX_CURRENCY     = re.compile(r"\b(USD|EUR|SAR|GBP|AED|JPY|CNY)\b")

RX_SOLD_TO      = re.compile(
    r"Sold To\s*:\s*(\d+)\s*\n([^\n]+)\n([\s\S]+?)\nShip To\s*:", re.I)
RX_SHIP_TO      = re.compile(
    r"Ship To\s*:\s*(\d+)\s*\n([^\n]+)\n([\s\S]+?)\nFreight Forwarder\s*:", re.I)
RX_NOTIFY_PARTY = re.compile(
    r"Notify Party\s*:\s*\n([\s\S]+?)\nShip From\s*:", re.I)
RX_EXPORTER     = re.compile(
    r"\nExporter\s*\n([\s\S]+?)\nwww\.", re.I)

# Totals: vertical column under "Inv. Currency"
RX_TOTALS = re.compile(
    r"Inv\.\s*Currency\s*\n+"
    r"\s*([\d.,]+)\s*\n+"     # freight
    r"\s*([\d.,]+)\s*\n+"     # vat
    r"\s*([\d.,]+)\s*\n+"     # material_total
    r"\s*([\d.,]+)\s*\n+"     # surcharge
    r"\s*([\d.,]+)\s*\n+"     # invoice_total
    r"\s*([A-Z]{3})\b",       # currency
    re.I,
)

# ---------------------------------------------------------------------------
# Per-item structure
# ---------------------------------------------------------------------------
# Each item's cell block has this vertical layout:
#   line 1:  unit-price UOM (1-3 uppercase letters)         e.g. PC, EA
#   line 2:  unit price (decimal)                            e.g. 97.49972
#   line 3:  qty (number, may include thousands separators)  e.g. 250 or 2,154.000
#   line 4:  qty UOM                                         e.g. PC, EA
#   lines 5..N-4: short description (1+ lines, may wrap)
#   line N-3: material id / customer material id (alphanumeric)
#   line N-2: order item (zero-padded, e.g. 000060)
#   line N-1: order (7 digits)
#   line N  : net amount (decimal e.g. 24,374.93)
#
# Followed by the "Purchase Order :" meta block.
RX_ITEM_ANCHOR = re.compile(
    r"\n([A-Z]{1,3})\n"        # up_uom
    r"(\d+\.\d+)\n"            # unit_price
    r"(\d[\d,]*(?:\.\d+)?)\n"  # qty
    r"([A-Z]{1,3})\n",         # uom
)

RX_PO_LINE      = re.compile(r"^Purchase Order\s*:\s*(\S+)", re.I | re.M)
RX_PO_ITEM_LINE = re.compile(r"^Purchase Order Item\s*:\s*(\S+)", re.I | re.M)
RX_ECCN         = re.compile(r"ECCN No\s*:\s*(\S+)", re.I)
RX_LICENSE      = re.compile(r"License No\s*:\s*(\S+)", re.I)
RX_COO          = re.compile(r"Country Of Origin\s*:\s*([A-Z]{2})", re.I)
RX_HTS          = re.compile(r"HTS Code\s*:\s*(\S+)", re.I)
RX_PREF         = re.compile(r"Preference\s*:\s*(\S+)", re.I)

RX_TERMS_LINE   = re.compile(r"Terms and Conditions\s*:[^\n]*", re.I)
RX_DISCLAIMER   = re.compile(r"This tariff classification", re.I)


class CommScopeParser(BaseInvoiceParser):
    name = "commscope"
    vendor = "CommScope"

    @classmethod
    def fingerprint(cls, text: str) -> bool:
        return ("CommScope" in text) or ("commscope.com" in text.lower())

    def parse(self, text: str, ctx: ParserContext) -> tuple[InvoiceRecord, list[str]]:
        rec = InvoiceRecord(
            source_file=str(ctx.source),
            page=ctx.page,
            vendor_name=self.vendor,
            parser_name=self.name,
            extraction_method=ctx.extraction_method,
        )
        self._parse_header(text, rec)
        self._parse_addresses(text, rec)
        self._parse_totals(text, rec)
        rec.items, segments = self._parse_items(text)
        return rec, segments

    # ------------------------------------------------------------------ header
    def _parse_header(self, text: str, rec: InvoiceRecord) -> None:
        if (m := RX_INVOICE_NO.search(text)):
            rec.commercial_invoice_number = m.group(1).strip()
        if (m := RX_INVOICE_DT.search(text)):
            rec.commercial_invoice_date = to_iso_date(m.group(1))
        if (m := RX_INCOTERMS.search(text)):
            rec.incoterms = m.group(1).strip()
        if (m := RX_SHIPMENT.search(text)):
            rec.shipment_number = m.group(1).strip()
        if (m := RX_SHIP_FROM.search(text)):
            rec.country = m.group(1).strip()

    # --------------------------------------------------------------- addresses
    def _parse_addresses(self, text: str, rec: InvoiceRecord) -> None:
        if (m := RX_SOLD_TO.search(text)):
            rec.sold_to = self._block_to_addr(m.group(1), m.group(2), m.group(3))
        if (m := RX_SHIP_TO.search(text)):
            rec.ship_to = self._block_to_addr(m.group(1), m.group(2), m.group(3))
        if (m := RX_EXPORTER.search(text)):
            rec.exporter = self._lines_to_addr(m.group(1))
        # In this batch the freight_forwarder column is empty; the visible block
        # at "Notify Party :" is the notify party, not the forwarder. Leave the
        # field empty rather than miscategorize.

    @staticmethod
    def _block_to_addr(code: str, name: str, body: str) -> Address:
        lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]
        return Address(
            code=code.strip(),
            name=name.strip(),
            address=", ".join(lines[:-1]) if len(lines) > 1 else (lines[0] if lines else ""),
            country=lines[-1] if lines else "",
        )

    @staticmethod
    def _lines_to_addr(body: str) -> Address:
        lines = [ln.strip() for ln in body.strip().splitlines() if ln.strip()]
        if not lines:
            return Address()
        return Address(
            name=lines[0],
            address=", ".join(lines[1:-1]) if len(lines) > 2 else (lines[1] if len(lines) > 1 else ""),
            country=lines[-1] if len(lines) > 1 else "",
        )

    # ------------------------------------------------------------------ totals
    def _parse_totals(self, text: str, rec: InvoiceRecord) -> None:
        m = RX_TOTALS.search(text)
        if not m:
            # Try a header-based fallback in case Inv. Currency is fragmented
            m = RX_CURRENCY.search(text)
            if m:
                rec.currency = m.group(1)
            return
        freight, vat, mat_total, surcharge, inv_total, currency = m.groups()
        rec.totals = {
            "freight": to_float(freight),
            "vat": to_float(vat),
            "material_total": to_float(mat_total),
            "surcharge": to_float(surcharge),
            "invoice_total": to_float(inv_total),
        }
        rec.invoice_total = to_float(inv_total)
        rec.currency = currency

    # ------------------------------------------------------------------- items
    def _parse_items(self, text: str) -> tuple[list[LineItem], list[str]]:
        m_terms = RX_TERMS_LINE.search(text)
        region_start = m_terms.end() if m_terms else 0
        m_disc = RX_DISCLAIMER.search(text, region_start)
        region_end = m_disc.start() if m_disc else len(text)
        region = text[region_start:region_end]

        po_anchors = list(re.finditer(r"^Purchase Order\s*:\s*\S+", region, re.M))
        if not po_anchors:
            return [], []

        # Locate the cell block start for each item.
        cell_block_starts: list[int] = [0]  # first item: cell block starts at region_start
        for i in range(1, len(po_anchors)):
            prev_meta_start = po_anchors[i - 1].end()
            next_meta_start = po_anchors[i].start()
            between = region[prev_meta_start:next_meta_start]
            m_pref = RX_PREF.search(between)
            scan_from = m_pref.end() if m_pref else 0
            m_anc = RX_ITEM_ANCHOR.search(between, scan_from)
            if m_anc:
                cell_block_starts.append(prev_meta_start + m_anc.start() + 1)
            else:
                cell_block_starts.append(prev_meta_start)

        items: list[LineItem] = []
        segments: list[str] = []
        for i, anchor in enumerate(po_anchors):
            cell_block = region[cell_block_starts[i]:anchor.start()]
            meta_end = cell_block_starts[i + 1] if i + 1 < len(po_anchors) else len(region)
            meta_block = region[anchor.start():meta_end]

            it = self._parse_cell_block(cell_block)
            if not it:
                continue
            self._parse_meta_block(meta_block, it)
            items.append(it)
            segments.append(cell_block + meta_block)
        return items, segments

    @staticmethod
    def _parse_cell_block(block: str) -> LineItem | None:
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        if len(lines) < 9:
            return None

        it = LineItem()
        it.unit_price_uom = lines[0]
        it.unit_price     = to_float(lines[1])
        it.qty            = to_float(lines[2])
        it.uom            = lines[3]
        it.amount         = to_float(lines[-1])
        it.order          = lines[-2]
        it.order_item     = lines[-3]
        material          = lines[-4]
        short_desc_lines  = lines[4:-4]

        if not _is_uom(it.unit_price_uom) or not _is_uom(it.uom):
            return None
        if not it.unit_price or not it.qty:
            return None
        if not re.fullmatch(r"\d{7}", it.order):
            return None
        if not re.fullmatch(r"0\d{4,5}", it.order_item):
            return None

        CommScopeParser._assign_material_id(it, material)
        it.short_description = collapse_whitespace(", ".join(short_desc_lines))
        return it

    @staticmethod
    def _assign_material_id(it: LineItem, matl: str) -> None:
        """CommScope packs ONE id per row; classify by pattern."""
        matl = matl.strip()
        if not matl:
            return
        if re.fullmatch(r"\d{9,}", matl):
            it.material_id = matl
        elif re.fullmatch(r"\d+-\d+", matl):
            it.material_id = matl
        elif re.fullmatch(r"[A-Z]{2,}[A-Z0-9\-]+", matl, re.I):
            it.customer_material_id = matl
        else:
            it.material_id = matl

    @staticmethod
    def _parse_meta_block(block: str, it: LineItem) -> None:
        if (m := RX_PO_LINE.search(block)):
            it.purchase_order = m.group(1).strip()
        if (m := RX_PO_ITEM_LINE.search(block)):
            it.purchase_order_item = m.group(1).strip()
        if (m := RX_ECCN.search(block)):
            it.eccn_no = m.group(1).strip()
        if (m := RX_LICENSE.search(block)):
            it.license_no = m.group(1).strip()
        if (m := RX_COO.search(block)):
            it.country_of_origin = m.group(1).strip()
        if (m := RX_HTS.search(block)):
            it.hts_code = m.group(1).strip()
        if (m := RX_PREF.search(block)):
            it.preference = m.group(1).strip()

        # Full description: everything after "Preference : XX\n" up to the next
        # item's cell-block start (already trimmed by the caller) or end-of-block.
        m_pref = RX_PREF.search(block)
        if m_pref:
            tail = block[m_pref.end():]
            anc = RX_ITEM_ANCHOR.search(tail)
            if anc:
                tail = tail[:anc.start()]
            it.description = collapse_whitespace(tail)
        if not it.description and it.short_description:
            it.description = it.short_description


def _is_uom(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{1,3}", s or ""))
