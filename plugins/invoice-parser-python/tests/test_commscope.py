"""Unit tests for the CommScope parser, driven by fixture page-text strings."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from invoice_parser.confidence import annotate
from invoice_parser.parsers.commscope import CommScopeParser
from invoice_parser.parsers.base import ParserContext

from tests.fixtures import PAGE_1_SIMPLE, PAGE_4_MULTI_WITH_WRAP


def _parse(text: str, page: int = 1):
    parser = CommScopeParser()
    ctx = ParserContext(source=Path("fixture.pdf"), page=page)
    rec, segs = parser.parse(text, ctx)
    annotate(rec)
    return rec, segs


class TestCommScopeHeader(unittest.TestCase):
    def test_fingerprint(self):
        self.assertTrue(CommScopeParser.fingerprint(PAGE_1_SIMPLE))
        self.assertTrue(CommScopeParser.fingerprint(PAGE_4_MULTI_WITH_WRAP))
        self.assertFalse(CommScopeParser.fingerprint("Acme widgets invoice 123"))

    def test_page1_header(self):
        rec, _ = _parse(PAGE_1_SIMPLE)
        self.assertEqual(rec.commercial_invoice_number, "9010114526")
        self.assertEqual(rec.commercial_invoice_date, "2026-01-19")
        self.assertEqual(rec.shipment_number, "22310386")
        self.assertEqual(rec.incoterms, "FCA COMMSCOPE FACTORY")
        self.assertEqual(rec.country, "NL")
        self.assertEqual(rec.currency, "USD")
        self.assertAlmostEqual(rec.invoice_total, 24374.93, places=2)
        self.assertEqual(rec.totals["material_total"], 24374.93)
        self.assertEqual(rec.totals["freight"], 0.0)

    def test_page1_addresses(self):
        rec, _ = _parse(PAGE_1_SIMPLE)
        self.assertEqual(rec.sold_to.code, "1012320")
        self.assertIn("GULF APPLICATION", rec.sold_to.name)
        self.assertEqual(rec.ship_to.code, "52571")
        self.assertIn("SAUDI ARABIA", rec.sold_to.country)
        self.assertIn("Commscope EMEA", rec.exporter.name)


class TestCommScopeItems(unittest.TestCase):
    def test_page1_single_item(self):
        rec, _ = _parse(PAGE_1_SIMPLE)
        self.assertEqual(len(rec.items), 1)
        it = rec.items[0]
        self.assertEqual(it.qty, 250.0)
        self.assertEqual(it.uom, "PC")
        self.assertAlmostEqual(it.unit_price, 97.49972, places=5)
        self.assertEqual(it.unit_price_uom, "PC")
        self.assertAlmostEqual(it.amount, 24374.93, places=2)
        self.assertEqual(it.order, "6116852")
        self.assertEqual(it.order_item, "000060")
        self.assertEqual(it.material_id, "760109496")
        self.assertEqual(it.purchase_order, "5500001219")
        self.assertEqual(it.purchase_order_item, "6")
        self.assertEqual(it.country_of_origin, "IN")
        self.assertEqual(it.hts_code, "85367000")
        self.assertEqual(it.eccn_no, "ECL99")
        self.assertEqual(it.license_no, "NLR")
        self.assertEqual(it.preference, "NO")
        self.assertIn("360G2 Cartridge", it.short_description)
        self.assertIn("Singlemode Fiber Cassette", it.description)
        self.assertGreaterEqual(it.confidence, 90)

    def test_page4_three_items_with_wrap(self):
        rec, _ = _parse(PAGE_4_MULTI_WITH_WRAP, page=4)
        self.assertEqual(len(rec.items), 3)

        i1, i2, i3 = rec.items
        self.assertEqual(i1.qty, 180.0)
        self.assertEqual(i1.material_id, "")
        self.assertEqual(i1.customer_material_id, "NPC06UZDB-WT005M")
        self.assertAlmostEqual(i1.amount, 1130.87, places=2)
        self.assertEqual(i1.purchase_order_item, "5")
        self.assertEqual(i1.country_of_origin, "TN")

        self.assertEqual(i2.qty, 100.0)
        self.assertEqual(i2.customer_material_id, "NPC06UZDB-WT010M")
        self.assertAlmostEqual(i2.amount, 990.86, places=2)
        self.assertEqual(i2.purchase_order_item, "6")

        # Wrap case: short description spans two lines BEFORE the trailer
        self.assertEqual(i3.qty, 229.0)
        self.assertEqual(i3.uom, "PC")
        self.assertAlmostEqual(i3.unit_price, 19.83825, places=5)
        self.assertEqual(i3.customer_material_id, "FFXLCLC42-MXF010")
        self.assertEqual(i3.order, "6184628")
        self.assertEqual(i3.order_item, "000070")
        self.assertAlmostEqual(i3.amount, 4542.96, places=2)
        self.assertIn("JUMPER", i3.short_description)
        self.assertIn("LC,AQ,FT010", i3.short_description)
        self.assertIn("OM4 LC to LC", i3.description)
        self.assertEqual(i3.country_of_origin, "CN")
        self.assertEqual(i3.hts_code, "85447000")

        # Sum of line amounts should match invoice total
        line_sum = round(sum(it.amount for it in rec.items), 2)
        self.assertEqual(line_sum, 6664.69)
        self.assertGreaterEqual(rec.confidence, 90)


class TestPdfIfPresent(unittest.TestCase):
    """Optional integration test against the real PDF on disk.

    Skipped automatically if INVOICE_TEST_PDF env var is unset or the file is missing.
    """

    def setUp(self):
        env = os.getenv("INVOICE_TEST_PDF")
        if not env:
            self.skipTest("INVOICE_TEST_PDF not set")
        self.pdf = Path(env).expanduser()
        if not self.pdf.exists():
            self.skipTest(f"{self.pdf} not found")

    def test_extract_pdf(self):
        from invoice_parser import extract_pdf
        records = extract_pdf(self.pdf)
        self.assertGreater(len(records), 0)
        for r in records:
            self.assertTrue(r["commercial_invoice_number"], f"missing inv number on page {r['page']}")
            self.assertTrue(r["items"], f"no items on page {r['page']}")
            self.assertGreaterEqual(r["confidence"], 80, f"low invoice conf on page {r['page']}: {r['warnings']}")


if __name__ == "__main__":
    unittest.main()
