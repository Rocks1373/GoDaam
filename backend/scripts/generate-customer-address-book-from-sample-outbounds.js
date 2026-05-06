#!/usr/bin/env node
/**
 * Builds customer-address-book.xlsx for /api/customers/upload from outbound sample xlsx files
 * in sample-data (Sold-to → Customer Number, Name 1 → Company Name).
 *
 * Usage (from backend/): node scripts/generate-customer-address-book-from-sample-outbounds.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SAMPLE_DIR = path.join(__dirname, '..', 'sample-data');
const OUT_FILE = path.join(SAMPLE_DIR, 'customer-address-book.xlsx');

const EXCEL_HEADERS = [
  'Customer Number',
  'Company Name',
  'City Name',
  'Address',
  'GPS',
  'Contact Person',
  'Contact Person Number',
  'Email 1',
  'Designation / Job',
  '2nd Name',
  '2nd Number',
  '2nd Email',
  'Designation / Job 2',
  'Remarks',
];

function pickOutboundXlsx(files) {
  return files.filter(
    (f) =>
      f.endsWith('.xlsx') &&
      (f.includes('outbound') || f.toLowerCase().includes('fifo-outbound'))
  );
}

function readRows(workbookPath) {
  const wb = XLSX.readFile(workbookPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function main() {
  if (!fs.existsSync(SAMPLE_DIR)) {
    console.error(`Missing folder: ${SAMPLE_DIR}`);
    process.exit(1);
  }

  const files = pickOutboundXlsx(fs.readdirSync(SAMPLE_DIR)).sort();

  /** @type {Map<string, {sold_to:string,name_1:string,custRef:Set<string>,sales:Set<string>,files:Set<string>,deliveries:Set<string>}>} */
  const byNumber = new Map();

  for (const f of files) {
    const fp = path.join(SAMPLE_DIR, f);
    const rows = readRows(fp);
    for (const r of rows) {
      const soldTo = String(r['Sold-to'] ?? r['Sold-To'] ?? '').trim();
      if (!soldTo) continue;

      const name1 = String(r['Name 1'] ?? r.Name1 ?? '').trim();
      const custRef = String(r['Customer Reference'] ?? '').trim();
      const salesDoc = String(r['Sales Doc.'] ?? r['Sales Doc'] ?? '').trim();
      const delivery = String(r.Delivery ?? '').trim();

      if (!byNumber.has(soldTo)) {
        byNumber.set(soldTo, {
          sold_to: soldTo,
          name_1: name1,
          custRef: new Set(),
          sales: new Set(),
          files: new Set(),
          deliveries: new Set(),
        });
      }
      const agg = byNumber.get(soldTo);
      if (name1) agg.name_1 = name1;
      if (custRef) agg.custRef.add(custRef);
      if (salesDoc) agg.sales.add(salesDoc);
      if (delivery) agg.deliveries.add(delivery);
      agg.files.add(f);
    }
  }

  if (!byNumber.size) {
    console.error(`No Sold-to rows found in outbound-like xlsx files under ${SAMPLE_DIR}`);
    process.exit(1);
  }

  const sortedKeys = [...byNumber.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  /** Plausible placeholders when samples have no addresses (manual edit after upload OK). */
  function suggestCityCompany(nameLower) {
    if (nameLower.includes('riyadh metro')) return 'Riyadh';
    if (nameLower.includes('kafd')) return 'Riyadh';
    return '';
  }

  const grid = [EXCEL_HEADERS];
  for (const key of sortedKeys) {
    const v = byNumber.get(key);
    const nameLower = String(v.name_1).toLowerCase();
    const city = suggestCityCompany(nameLower);

    const remarks = [
      'Generated from outbound sample uploads.',
      v.deliveries.size ? `Deliveries: ${[...v.deliveries].sort().join(', ')}.` : '',
      v.custRef.size ? `Customer refs: ${[...v.custRef].sort().join('; ')}.` : '',
      v.sales.size ? `Sales docs: ${[...v.sales].sort().join('; ')}.` : '',
      `Sources: ${[...v.files].sort().join(', ')}.`,
    ]
      .filter(Boolean)
      .join(' ');

    const rowObj = {};
    EXCEL_HEADERS.forEach((h) => {
      rowObj[h] = '';
    });
    rowObj['Customer Number'] = v.sold_to;
    rowObj['Company Name'] = v.name_1 || v.sold_to;
    if (city) rowObj['City Name'] = city;
    rowObj['Remarks'] = remarks;

    grid.push(EXCEL_HEADERS.map((h) => rowObj[h]));
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(grid);
  XLSX.utils.book_append_sheet(wb, ws, 'customer-address-book');

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  XLSX.writeFile(wb, OUT_FILE);

  console.log(`Wrote ${OUT_FILE}`);
  console.log(`Customers: ${byNumber.size} (from ${files.length} outbound sample file(s)).`);
}

main();
