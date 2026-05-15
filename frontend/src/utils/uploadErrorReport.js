import * as XLSX from 'xlsx';

function pick(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return '';
}

export function uploadFailures(results) {
  return (Array.isArray(results) ? results : []).filter((r) => r && (r.error || r.ok === false || r.failed));
}

export function uploadSummary(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const failed = uploadFailures(results);
  const total = Number.isFinite(Number(data?.total)) ? Number(data.total) : results.length;
  const success = Number.isFinite(Number(data?.success)) ? Number(data.success) : Math.max(0, total - failed.length);
  return { results, failed, total, success };
}

export function downloadUploadErrorWorkbook({ data, results, filenamePrefix = 'upload', sheetName = 'Upload Errors' }) {
  const failed = uploadFailures(results || data?.results);
  if (!failed.length) return 0;

  const rows = failed.map((failure, index) => {
    const source = failure.row || failure.raw || {};
    return {
      'Row #': failure.row_index ?? failure.rowNumber ?? failure.index ?? index + 1,
      'Issue / Remark': failure.error || failure.reason || failure.message || 'Upload failed',
      'Part Number': failure.part_number || pick(source, 'Part Number', 'part_number', 'Material', 'material'),
      'SAP Part Number': failure.sap_part_number || pick(source, 'SAP Part Number', 'sap_part_number'),
      Delivery: failure.delivery || pick(source, 'Delivery', 'delivery'),
      'Sales Doc': failure.sales_doc || pick(source, 'Sales Doc', 'sales_doc'),
      Qty:
        failure.qty ??
        failure.inbound_qty ??
        failure.outbound_qty ??
        failure.required_qty ??
        pick(source, 'Qty', 'Inbound Qty', 'Outbound Qty', 'Required Qty', 'qty'),
      Status: failure.status || '',
      ...source,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  XLSX.writeFile(wb, `${filenamePrefix}-errors-${stamp}.xlsx`);
  return failed.length;
}

export function uploadResultMessage(data, label = 'Upload') {
  const { failed, total, success } = uploadSummary(data);
  if (!total) return `${label}: no data rows found.`;
  if (!failed.length) return `${label}: imported ${success} of ${total} row(s). Everything uploaded successfully.`;
  return `${label}: imported ${success} of ${total} row(s). ${failed.length} row(s) failed; an error Excel was downloaded.`;
}

export function reportUploadResult(data, { label = 'Upload', filenamePrefix = 'upload', notify = alert } = {}) {
  const failedCount = downloadUploadErrorWorkbook({ data, filenamePrefix });
  const message = uploadResultMessage(data, label);
  if (typeof notify === 'function') notify(message);
  return { ...uploadSummary(data), failedCount };
}

export function reportUploadError(error, { label = 'Upload', filenamePrefix = 'upload', notify = alert } = {}) {
  const data = error?.response?.data;
  const failedCount = downloadUploadErrorWorkbook({ data, filenamePrefix });
  const base = data?.error || error?.message || `${label} failed`;
  const message = failedCount ? `${base}\n\nDownloaded an error Excel with ${failedCount} failed row(s).` : base;
  if (typeof notify === 'function') notify(message);
  return { failedCount, message };
}
