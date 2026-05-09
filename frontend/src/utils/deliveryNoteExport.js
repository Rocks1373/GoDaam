import * as XLSX from 'xlsx';

/** Remove characters illegal in Windows/macOS file names. */
export function sanitizeFilenameSegment(s) {
  return String(s ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .trim()
    .slice(0, 120);
}

/**
 * RG_{invoice}_{outbound}_{customer_po}_{customer_name}_{gapp_po}.pdf|.xlsx
 * Empty segments become "-" so positions stay readable.
 */
export function buildDeliveryNoteFilename(view, ext) {
  const seg = (v) => {
    const t = sanitizeFilenameSegment(v);
    return t.length ? t : '-';
  };
  const parts = [
    'RG',
    seg(view?.invoice_number ?? view?.header?.invoice_number),
    seg(view?.outbound_number),
    seg(view?.customer_po ?? view?.customer_reference),
    seg(view?.customer_name),
    seg(view?.gapp_po),
  ];
  const base = parts.join('_').replace(/_+/g, '_');
  const e = String(ext || '.xlsx').startsWith('.') ? ext : `.${ext}`;
  return `${base}${e}`;
}

function pushRow(rows, ...cells) {
  rows.push([...cells]);
}

/**
 * Excel workbook mirroring the delivery note sections (header, delivery to, line table, totals, transport, receiver).
 */
export function buildDeliveryNoteExcelSheet({
  view,
  displayItems,
  packageText,
  transportRenderLines,
}) {
  const rows = [];
  pushRow(rows, 'Gulf Applications');
  pushRow(rows, 'Apartment 5001, 50th Floor, Kingdom Tower');
  pushRow(rows, 'P.O Box 89098, Riyadh, Saudi Arabia');
  pushRow(rows, 'Tel / Fax');
  pushRow(rows);
  pushRow(rows, 'DELIVERY NOTE');
  pushRow(rows);
  pushRow(rows, 'DATE', view?.dn_date ?? '');
  pushRow(rows, 'GAPP PO', view?.gapp_po ?? '');
  pushRow(rows, 'CUSTOMER PO', view?.customer_po ?? '');
  pushRow(rows, 'OUTBOUND', view?.outbound_number ?? '');
  pushRow(rows, 'INVOICE', view?.invoice_number ?? '');
  pushRow(rows);
  pushRow(rows, 'SPO', view?.spo ?? 'SCHNEIDER STOCK');
  pushRow(rows);
  pushRow(rows, 'Delivery to:', '');
  pushRow(rows, '', view?.customer_name ?? '');
  const addr = String(view?.delivery_address ?? '').trim();
  if (addr) pushRow(rows, '', addr);
  const city = String(view?.city_name ?? '').trim();
  if (city) pushRow(rows, '', city);
  const gps = String(view?.gps ?? '').trim();
  if (gps) pushRow(rows, '', gps);
  pushRow(rows);

  const c1 = [view?.contact_person, view?.contact_number].filter(Boolean).join(' - ');
  if (String(c1).trim()) {
    pushRow(rows, 'Contact Person:', c1);
  }
  const c2 = [view?.contact_person_2, view?.contact_number_2].filter(Boolean).join(' - ');
  if (String(c2).trim()) {
    pushRow(rows, 'Contact Person:', c2);
  }
  const rem = String(view?.deliver_to_remarks ?? '').trim();
  if (rem) {
    pushRow(rows, 'Delivery remarks:', rem);
  }
  if (c1 || c2 || rem) pushRow(rows);

  pushRow(rows, 'Item #', 'Part Number', 'Description', 'Qty', 'UOM', 'Serial No.', 'Condition');
  displayItems.forEach((it, idx) => {
    pushRow(
      rows,
      idx + 1,
      it?.part_number ?? '',
      it?.description ?? '',
      it?.qty ?? '',
      it?.uom ?? '',
      it?.serial_no ?? '-',
      it?.condition_text ?? it?.condition ?? 'New'
    );
  });
  pushRow(rows);

  pushRow(rows, 'Total', packageText ?? '');
  pushRow(rows, 'gross weight(KG)', Number(view?.gross_weight_kg || 0));
  pushRow(rows, 'volume(CBM)', Number(view?.volume_cbm || 0));
  pushRow(rows);

  if (transportRenderLines?.length) {
    pushRow(rows, 'Transportation');
    transportRenderLines.forEach((l) => pushRow(rows, l.k, l.v ?? ''));
  } else {
    pushRow(rows, 'Transportation', 'Method not set.');
  }
  pushRow(rows);

  pushRow(
    rows,
    'Receiver',
    'Below fields are mandatory to be filled by the Receiver; stated particulars must be true and correct.'
  );
  pushRow(rows, 'NAME', '');
  pushRow(rows, 'SIGN', '');
  pushRow(rows, 'Mobile no.', '');
  pushRow(rows, 'DATE', '');
  pushRow(rows, 'STAMP', '');

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 14 },
    { wch: 22 },
    { wch: 48 },
    { wch: 10 },
    { wch: 8 },
    { wch: 14 },
    { wch: 12 },
  ];

  const end = 6;
  // Row indices: 0–3 company, 4 blank, 5 title "DELIVERY NOTE"
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: end } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: end } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: end } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: end } },
    { s: { r: 5, c: 0 }, e: { r: 5, c: end } },
  ];

  return ws;
}

export function downloadDeliveryNoteExcel(args) {
  const ws = buildDeliveryNoteExcelSheet(args);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Delivery Note');
  const filename = buildDeliveryNoteFilename(args.view, '.xlsx');
  XLSX.writeFile(wb, filename);
}
