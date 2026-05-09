"""CLI entrypoint for the invoice parser.

Usage:
    python cli.py <input.pdf> [-o OUT_DIR] [--vendor commscope] [--ai-cleanup]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from invoice_parser import extract_pdf, to_csv, to_excel, to_json


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Parse commercial invoice PDFs.")
    p.add_argument("pdf", type=Path, help="Path to invoice PDF")
    p.add_argument("-o", "--out", type=Path, default=Path("./out"), help="Output directory")
    p.add_argument("--vendor", type=str, default=None, help="Force vendor parser (e.g., commscope)")
    p.add_argument("--ai-cleanup", action="store_true", help="Use Claude API for low-confidence rows")
    p.add_argument("--threshold", type=int, default=70, help="AI cleanup confidence threshold (default 70)")
    p.add_argument("--no-excel", action="store_true")
    p.add_argument("--no-csv", action="store_true")
    args = p.parse_args(argv)

    if not args.pdf.exists():
        print(f"error: {args.pdf} does not exist", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    base = args.pdf.stem

    records = extract_pdf(
        args.pdf,
        forced_vendor=args.vendor,
        ai_cleanup=args.ai_cleanup,
        ai_threshold=args.threshold,
    )

    json_path = to_json(records, args.out / f"{base}.json")
    print(f"json  -> {json_path}")
    if not args.no_excel:
        x = to_excel(records, args.out / f"{base}.xlsx")
        print(f"excel -> {x}")
    if not args.no_csv:
        c = to_csv(records, args.out / f"{base}.csv")
        print(f"csv   -> {c}")

    n_items = sum(len(r.get("items") or []) for r in records)
    n_warn  = sum(len(r.get("warnings") or []) for r in records)
    n_low   = sum(1 for r in records for it in (r.get("items") or []) if it.get("confidence", 0) < 80)
    print(f"\n{len(records)} pages, {n_items} line items, {n_warn} invoice warnings, {n_low} items < 80 confidence")

    for r in records:
        if r.get("warnings") or any((it.get("confidence", 100) < 80) for it in (r.get("items") or [])):
            print(f"\npage {r['page']}  invoice={r['commercial_invoice_number']}  conf={r['confidence']}")
            for w in r.get("warnings", []):
                print(f"  ! {w}")
            for it in r.get("items") or []:
                if it.get("confidence", 100) < 80 or it.get("issues"):
                    print(f"  item conf={it['confidence']}  matl={it['material_id'] or it['customer_material_id']}  issues={it['issues']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
