from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd


_HEADER_FIELDS = [
    "source_file", "page", "vendor_name", "parser_name", "extraction_method",
    "commercial_invoice_number", "commercial_invoice_date",
    "shipment_number", "incoterms", "currency", "invoice_total",
    "country", "confidence",
]
_ITEM_FIELDS = [
    "purchase_order", "purchase_order_item", "order", "order_item",
    "qty", "uom", "unit_price", "unit_price_uom", "amount",
    "material_id", "customer_material_id",
    "short_description", "description",
    "country_of_origin", "hts_code", "eccn_no", "license_no", "preference",
    "confidence",
]


def to_json(records: list[dict[str, Any]], dst: str | Path) -> Path:
    dst = Path(dst)
    dst.write_text(json.dumps(records, indent=2, ensure_ascii=False))
    return dst


def _flat_rows(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for r in records:
        if not r.get("items"):
            row = {f"invoice.{k}": r.get(k) for k in _HEADER_FIELDS}
            row["invoice.warnings"] = "; ".join(r.get("warnings", []))
            rows.append(row)
            continue
        for it in r["items"]:
            row = {f"invoice.{k}": r.get(k) for k in _HEADER_FIELDS}
            row["invoice.warnings"] = "; ".join(r.get("warnings", []))
            for k in _ITEM_FIELDS:
                row[f"item.{k}"] = it.get(k)
            row["item.issues"] = "; ".join(it.get("issues", []))
            rows.append(row)
    return rows


# Columns that must stay as strings to preserve leading zeros / hyphens.
_FORCE_STRING_COLS = {
    "invoice.commercial_invoice_number",
    "invoice.shipment_number",
    "item.purchase_order",
    "item.purchase_order_item",
    "item.order",
    "item.order_item",
    "item.material_id",
    "item.customer_material_id",
    "item.hts_code",
    "item.eccn_no",
}


def _coerce_strings(df: pd.DataFrame) -> pd.DataFrame:
    for col in df.columns:
        if col in _FORCE_STRING_COLS:
            df[col] = df[col].astype("string")
    return df


def to_excel(records: list[dict[str, Any]], dst: str | Path) -> Path:
    dst = Path(dst)
    rows = _flat_rows(records)
    df_items = _coerce_strings(pd.DataFrame(rows))

    df_invoices = pd.DataFrame([
        {**{k: r.get(k) for k in _HEADER_FIELDS},
         "warnings": "; ".join(r.get("warnings", [])),
         "duplicates": "; ".join(r.get("duplicates", [])),
         "n_items": len(r.get("items") or [])}
        for r in records
    ])
    if "commercial_invoice_number" in df_invoices.columns:
        df_invoices["commercial_invoice_number"] = df_invoices["commercial_invoice_number"].astype("string")
    if "shipment_number" in df_invoices.columns:
        df_invoices["shipment_number"] = df_invoices["shipment_number"].astype("string")

    with pd.ExcelWriter(dst, engine="openpyxl") as w:
        df_invoices.to_excel(w, sheet_name="invoices", index=False)
        df_items.to_excel(w, sheet_name="items", index=False)
    return dst


def to_csv(records: list[dict[str, Any]], dst: str | Path) -> Path:
    dst = Path(dst)
    df = _coerce_strings(pd.DataFrame(_flat_rows(records)))
    df.to_csv(dst, index=False)
    return dst
