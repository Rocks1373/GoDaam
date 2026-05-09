from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Address:
    code: str = ""
    name: str = ""
    address: str = ""
    country: str = ""


@dataclass
class LineItem:
    purchase_order: str = ""
    purchase_order_item: str = ""
    order: str = ""
    order_item: str = ""
    qty: float = 0.0
    uom: str = ""
    unit_price: float = 0.0
    unit_price_uom: str = ""
    amount: float = 0.0
    description: str = ""
    short_description: str = ""
    material_id: str = ""
    customer_material_id: str = ""
    country_of_origin: str = ""
    hts_code: str = ""
    eccn_no: str = ""
    license_no: str = ""
    preference: str = ""
    confidence: int = 0
    issues: list[str] = field(default_factory=list)


@dataclass
class InvoiceRecord:
    source_file: str = ""
    page: int = 0
    vendor_name: str = ""
    parser_name: str = ""
    commercial_invoice_number: str = ""
    commercial_invoice_date: str = ""
    shipment_number: str = ""
    incoterms: str = ""
    currency: str = ""
    invoice_total: float = 0.0
    sold_to: Address = field(default_factory=Address)
    ship_to: Address = field(default_factory=Address)
    freight_forwarder: Address = field(default_factory=Address)
    exporter: Address = field(default_factory=Address)
    country: str = ""
    items: list[LineItem] = field(default_factory=list)
    totals: dict[str, float] = field(default_factory=dict)
    confidence: int = 0
    warnings: list[str] = field(default_factory=list)
    duplicates: list[str] = field(default_factory=list)
    extraction_method: str = "text"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
