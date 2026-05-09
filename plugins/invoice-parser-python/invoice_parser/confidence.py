from __future__ import annotations

from .models import InvoiceRecord, LineItem

ITEM_RULES = [
    ("material_id_present",   25, lambda it: bool(it.material_id or it.customer_material_id)),
    ("order_present",         15, lambda it: bool(it.order)),
    ("qty_positive",          15, lambda it: it.qty > 0),
    ("price_positive",        15, lambda it: it.unit_price > 0),
    ("amount_positive",       10, lambda it: it.amount > 0),
    ("description_present",   10, lambda it: bool(it.description) or bool(it.short_description)),
    ("math_check",            10, lambda it: _math_ok(it)),
]

INVOICE_RULES = [
    ("invoice_number_present",   20, lambda r: bool(r.commercial_invoice_number)),
    ("invoice_date_present",     15, lambda r: bool(r.commercial_invoice_date)),
    ("currency_present",         10, lambda r: bool(r.currency)),
    ("totals_present",           10, lambda r: r.invoice_total > 0),
    ("sold_to_present",          10, lambda r: bool(r.sold_to.code or r.sold_to.name)),
    ("items_present",            15, lambda r: bool(r.items)),
    ("totals_match_items",       20, lambda r: _totals_ok(r)),
]


def _math_ok(it: LineItem) -> bool:
    if not it.qty or not it.unit_price:
        return False
    expected = round(it.qty * it.unit_price, 2)
    return abs(expected - it.amount) <= max(0.05, it.amount * 0.001)


def _totals_ok(rec: InvoiceRecord) -> bool:
    if not rec.items or not rec.invoice_total:
        return False
    line_sum = round(sum(it.amount for it in rec.items), 2)
    return abs(line_sum - rec.invoice_total) <= max(0.05, rec.invoice_total * 0.002)


def score_item(it: LineItem) -> tuple[int, list[str]]:
    score = 0
    failures = []
    for name, weight, check in ITEM_RULES:
        if check(it):
            score += weight
        else:
            failures.append(name)
    return score, failures


def score_invoice(rec: InvoiceRecord) -> tuple[int, list[str]]:
    score = 0
    failures = []
    for name, weight, check in INVOICE_RULES:
        if check(rec):
            score += weight
        else:
            failures.append(name)
    return score, failures


def annotate(rec: InvoiceRecord) -> None:
    """Score every item and the invoice as a whole. Mutates `rec` in place."""
    for it in rec.items:
        s, fails = score_item(it)
        it.confidence = s
        if fails:
            it.issues.extend(fails)
    s, fails = score_invoice(rec)
    rec.confidence = s
    if fails:
        rec.warnings.extend(fails)
