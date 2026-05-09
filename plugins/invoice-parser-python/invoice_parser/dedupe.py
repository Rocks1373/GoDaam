from __future__ import annotations

from .models import InvoiceRecord


def mark_duplicates(records: list[InvoiceRecord]) -> None:
    """Mark duplicate (invoice_number, order_item, material_id) tuples within a batch."""
    seen: dict[tuple[str, str, str], int] = {}
    for rec in records:
        for it in rec.items:
            key = (rec.commercial_invoice_number, it.order_item, it.material_id or it.customer_material_id)
            if all(key):
                seen[key] = seen.get(key, 0) + 1
    duplicate_keys = {k for k, n in seen.items() if n > 1}
    if not duplicate_keys:
        return
    for rec in records:
        for it in rec.items:
            key = (rec.commercial_invoice_number, it.order_item, it.material_id or it.customer_material_id)
            if key in duplicate_keys:
                tag = f"duplicate:{key[1]}/{key[2]}"
                it.issues.append("duplicate_in_batch")
                if tag not in rec.duplicates:
                    rec.duplicates.append(tag)
