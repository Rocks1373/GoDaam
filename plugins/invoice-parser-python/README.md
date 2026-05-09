# invoice-parser-python

Vendor-pluggable commercial-invoice parser. Built for CommScope; architected for additional vendors.

## Pipeline

1. **Text extraction** — PyMuPDF text layer (born-digital PDFs).
2. **OCR fallback** — pytesseract on rendered page when text layer is absent or too thin.
3. **Vendor detection** — `parsers/router.py` picks the right parser by document fingerprint.
4. **Pattern parsing** — vendor parser uses anchor/trailer regex + multi-line reconstruction.
5. **Normalization** — text cleanup, OCR character correction, fuzzy match against optional catalog.
6. **Confidence scoring** — every line item gets a 0–100 score; rows below threshold are flagged.
7. **AI cleanup (optional)** — low-confidence rows can be re-checked via the Anthropic API.
8. **Duplicate detection** — within a batch, by `(invoice_number, order_item, material_id)`.
9. **Export** — JSON, Excel, CSV.

## Usage

```bash
pip install -r requirements.txt
python cli.py /path/to/invoices.pdf -o ./out/
```

Outputs:
- `./out/<basename>.json`
- `./out/<basename>.xlsx`
- `./out/<basename>.csv`

Flags:
- `--ai-cleanup` — call Claude on rows scoring below threshold (needs `ANTHROPIC_API_KEY`).
- `--threshold N` — confidence threshold (default 80).
- `--vendor commscope` — force a specific parser (skip auto-detect).

## Adding a new vendor

1. Create `invoice_parser/parsers/<vendor>.py` with a class subclassing `BaseInvoiceParser`.
2. Implement `fingerprint(text) -> bool` (cheap document-level detection).
3. Implement `parse(text, page, source) -> InvoiceRecord`.
4. Register the class in `invoice_parser/parsers/router.py`.

## Field map (CommScope)

| Spec field                     | Source                                                   |
| ------------------------------ | -------------------------------------------------------- |
| commercial_invoice_number      | line below `Commercial Invoice Number`                   |
| commercial_invoice_date        | line below `Commercial Invoice Date` (`DD MON YYYY`)     |
| shipment_number                | numeric token before `Shipment Number`                   |
| incoterms                      | line below `Incoterms`                                   |
| currency                       | last token of `Inv. Currency` totals row                 |
| invoice_total                  | 5th amount of totals row                                 |
| sold_to_name / code            | `Sold To :` block                                        |
| ship_to_name                   | `Ship To :` block                                        |
| freight_forwarder              | `Freight Forwarder :` block                              |
| exporter                       | block below `Exporter`                                   |
| country (ship_from)            | 2-letter code before `Ship From Country`                 |
| **Item rows (anchor/trailer)** |                                                          |
| qty / uom / unit_price / u/p   | `\d[\d,]*(?:\.\d+)? [A-Z]{1,3} \d+\.\d+ [A-Z]{1,3}`      |
| order / order_item / matl id / amount | `\d{7} 0\d{5} \S+ -?\d[\d,]*\.\d{2}`              |
| description                    | text before anchor + text between anchor and trailer + line below `Preference :` in meta |
| purchase_order / po_item       | `Purchase Order : N` / `Purchase Order Item : N`         |
| country_of_origin / hts_code   | `Country Of Origin: XX` / `HTS Code : N`                 |
| eccn_no                        | `ECCN No: X`                                             |
