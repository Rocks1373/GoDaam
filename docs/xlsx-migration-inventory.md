# GoDam — XLSX (`SheetJS`) migration inventory

The `xlsx` package has known security advisories on npm. Prefer **`exceljs`** for parsing user-uploaded spreadsheets.

## Migrated to exceljs

| Location | Notes |
|----------|--------|
| [`backend/routes/stock-in.js`](../backend/routes/stock-in.js) | `POST /upload` uses [`backend/utils/readXlsxFirstSheetExceljs.js`](../backend/utils/readXlsxFirstSheetExceljs.js). |

## Still using `xlsx` (migrate next)

| Area | Files |
|------|--------|
| Backend routes | `outbound.js`, `inbound.js`, `main-stock.js`, `customers.js`, `sold-out.js`, `sap-stock.js`, `bom.js`, `vendors.js`, `vendor-items.js`, `stock-out.js`, `reports.js`, `transportation.js`, `godam-excel.js` |
| Backend services | `huaweiGodamImporter.js` |
| Backend scripts | `seed-sample-data.js`, `seed-test-data.js`, `generate-customer-address-book-from-sample-outbounds.js` |
| Frontend | `Customers.jsx`, `StockIn.jsx`, `StockOut.jsx`, `StockByRackSummary.jsx`, `DeliveryReport.jsx`, `ReportExportPage.jsx`, `utils/deliveryNoteExport.js` |

CI runs `npm audit --audit-level=critical` for **backend** and **frontend** because **`xlsx` (SheetJS)** remains on a known **high** advisory set with **no fix on npm** until routes are migrated to **exceljs** (see table above). Treat remaining `xlsx` usage as accepted risk with a migration deadline, not as silent debt.
