from __future__ import annotations

import json
import os

from .models import InvoiceRecord, LineItem

_PROMPT = """You normalize fields extracted from a commercial invoice line item.

Given the raw cell text and the parser's current guess, return a JSON object with the SAME keys but corrected if obviously wrong. Do NOT invent fields; if you are uncertain, keep the parser's value. Return ONLY the JSON, no commentary.

Raw cell text:
---
{raw}
---

Current parsed values:
{guess}

Return a JSON object with these keys: order, order_item, material_id, qty, uom, unit_price, amount, short_description.
"""


def cleanup_low_confidence(
    rec: InvoiceRecord,
    raw_segments: list[str],
    threshold: int = 70,
    model: str = "claude-haiku-4-5-20251001",
) -> int:
    """Re-check items below `threshold` using Claude. Returns count of items touched.

    `raw_segments[i]` should be the raw text segment used to parse `rec.items[i]`.
    No-op if ANTHROPIC_API_KEY is unset or the anthropic SDK is unavailable.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        return 0
    try:
        from anthropic import Anthropic
    except ImportError:
        return 0

    targets = [
        (i, it) for i, it in enumerate(rec.items)
        if it.confidence < threshold and i < len(raw_segments)
    ]
    if not targets:
        return 0

    client = Anthropic()
    touched = 0
    for i, it in targets:
        prompt = _PROMPT.format(
            raw=raw_segments[i].strip(),
            guess=json.dumps({
                "order": it.order, "order_item": it.order_item,
                "material_id": it.material_id, "qty": it.qty,
                "uom": it.uom, "unit_price": it.unit_price,
                "amount": it.amount, "short_description": it.short_description,
            }, indent=2),
        )
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
            if text.startswith("```"):
                text = text.strip("`").split("\n", 1)[-1].rsplit("```", 1)[0]
            data = json.loads(text)
            _apply_corrections(it, data)
            it.issues.append("ai_cleanup_applied")
            touched += 1
        except (json.JSONDecodeError, Exception) as e:
            it.issues.append(f"ai_cleanup_failed:{type(e).__name__}")
    return touched


def _apply_corrections(it: LineItem, data: dict) -> None:
    str_fields = ("order", "order_item", "material_id", "uom", "short_description")
    num_fields = ("qty", "unit_price", "amount")
    for f in str_fields:
        v = data.get(f)
        if isinstance(v, str) and v and not getattr(it, f):
            setattr(it, f, v)
    for f in num_fields:
        v = data.get(f)
        if isinstance(v, (int, float)) and v and not getattr(it, f):
            setattr(it, f, float(v))
