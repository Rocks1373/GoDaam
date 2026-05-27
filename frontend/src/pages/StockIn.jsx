import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Eye, FileDown, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import * as XLSX from 'xlsx';
import { stockInApi, vendorItemsApi, vendorsApi } from '../services/api';
import { formatDateDDMMYYYY } from '../utils/dateDisplay';
import { reportUploadError, reportUploadResult } from '../utils/uploadErrorReport';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import { exportJsonToExcel } from '../utils/exportExcel';

/**
 * Tab-separated (Excel paste) or comma-separated TXT/CSV; delimiter chosen per line.
 * Rack scan mobile export (8 cols): transaction_date, part_number, sap_part_number, rack_location, qty_in, source_type, reference_no, remarks
 * Legacy (9 cols): same with description after sap_part_number.
 */
function parsePastedStockRows(text) {
  const rawLines = (text || '')
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l) => l.trim());

  if (!rawLines.length) return [];

  const first = rawLines[0].toLowerCase();
  const hasHeader = first.includes('transaction_date') && first.includes('part_number') && first.includes('rack_location');
  const lines = hasHeader ? rawLines.slice(1) : rawLines;

  return lines.map((line) => {
    const cols = line.includes('\t') ? line.split('\t') : line.split(',').map((c) => String(c).trim());
    const t = (i) => (cols[i] ?? '').trim();

    if (cols.length === 8) {
      const qtyNum = parseFloat(String(t(4) || '').replace(/,/g, ''));
      return {
        transaction_date: t(0),
        part_number: t(1),
        sap_part_number: t(2),
        description: '-',
        rack_location: t(3),
        qty_in: Number.isFinite(qtyNum) ? qtyNum : NaN,
        source_type: t(5),
        reference_no: t(6),
        remarks: t(7),
      };
    }

    const qtyRaw = cols[5];
    const qtyNum = parseFloat(String(qtyRaw || '').replace(/,/g, ''));
    return {
      transaction_date: t(0),
      part_number: t(1),
      sap_part_number: t(2),
      description: t(3) || '-',
      rack_location: t(4),
      qty_in: Number.isFinite(qtyNum) ? qtyNum : NaN,
      source_type: t(6),
      reference_no: t(7),
      remarks: t(8),
    };
  });
}

const StockIn = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showEditModal, setShowEditModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({
    transaction_date: new Date().toISOString().slice(0, 10),
    vendor_id: '',
    vendor_name: '',
    part_number: '',
    sap_part_number: '',
    description: '',
    uom: '',
    rack_location: '',
    qty_in: '',
    source_type: '',
    reference_no: '',
    remarks: '',
  });

  const [vendors, setVendors] = useState([]);
  const [vendorItems, setVendorItems] = useState([]);
  const [loadingVendorItems, setLoadingVendorItems] = useState(false);

  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const fileRef = useRef(null);

  const fetchRows = async () => {
    try {
      setLoading(true);
      const data = await stockInApi.list({ limit: 500 });
      setRows(data || []);
    } catch (e) {
      console.error('Failed loading stock in:', e);
      alert('Failed to load Stock In: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
  }, []);

  const refreshVendors = async () => {
    try {
      const v = await vendorsApi.list('');
      setVendors(Array.isArray(v) ? v.filter((x) => x.is_active !== 0) : []);
    } catch {
      setVendors([]);
    }
  };

  const loadVendorItems = async (vendorId) => {
    if (!vendorId) {
      setVendorItems([]);
      return;
    }
    setLoadingVendorItems(true);
    try {
      const data = await vendorItemsApi.list({ vendor_id: vendorId });
      setVendorItems(Array.isArray(data) ? data.filter((x) => x.is_active !== 0) : []);
    } catch {
      setVendorItems([]);
    } finally {
      setLoadingVendorItems(false);
    }
  };

  const emptyForm = () => ({
    transaction_date: new Date().toISOString().slice(0, 10),
    vendor_id: '',
    vendor_name: '',
    part_number: '',
    sap_part_number: '',
    description: '',
    uom: '',
    rack_location: '',
    qty_in: '',
    source_type: '',
    reference_no: '',
    remarks: '',
  });

  const onVendorPick = (vendorId) => {
    const v = vendors.find((x) => String(x.id) === String(vendorId));
    setForm((f) => ({
      ...f,
      vendor_id: vendorId,
      vendor_name: v?.vendor_name || '',
      part_number: '',
      sap_part_number: '',
      description: '',
      uom: '',
    }));
    loadVendorItems(vendorId);
  };

  const onPartPick = (partNumber) => {
    const item = vendorItems.find((x) => x.part_number === partNumber);
    if (!item) {
      setForm((f) => ({ ...f, part_number: partNumber }));
      return;
    }
    setForm((f) => ({
      ...f,
      part_number: item.part_number,
      sap_part_number: item.sap_part_number || '',
      description: item.description || '',
      uom: item.uom || '',
      vendor_name: item.vendor_name || f.vendor_name,
    }));
  };

  const stockInSortValue = useCallback((r, k) => {
    if (k === 'qty_in') return Number(r.qty_in) || 0;
    if (k === 'transaction_date') {
      const t = r.transaction_date ? new Date(r.transaction_date).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return r[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, stockInSortValue);

  const openCreate = () => {
    setEditId(null);
    setForm(emptyForm());
    setVendorItems([]);
    refreshVendors();
    setShowEditModal(true);
  };

  const openEdit = (row) => {
    setEditId(row.id);
    setForm({
      transaction_date: String(row.transaction_date || '').slice(0, 10),
      vendor_id: row.vendor_id != null ? String(row.vendor_id) : '',
      vendor_name: row.vendor_name || '',
      part_number: row.part_number || '',
      sap_part_number: row.sap_part_number || '',
      description: row.description || '',
      uom: row.uom || '',
      rack_location: row.rack_location || '',
      qty_in: String(row.qty_in ?? ''),
      source_type: row.source_type || '',
      reference_no: row.reference_no || '',
      remarks: row.remarks || '',
    });
    refreshVendors();
    if (row.vendor_id) loadVendorItems(String(row.vendor_id));
    else setVendorItems([]);
    setShowEditModal(true);
  };

  const submitSingle = async () => {
    try {
      const payload = {
        ...form,
        vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
        qty_in: parseFloat(form.qty_in) || 0,
      };
      if (editId) await stockInApi.update(editId, payload);
      else await stockInApi.create(payload);
      setShowEditModal(false);
      fetchRows();
      alert(editId ? 'Stock In updated.' : 'Stock In saved.');
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const deleteRow = async () => {
    if (!editId) return;
    if (!confirm('Delete this Stock In entry? This will adjust rack totals.')) return;
    try {
      await stockInApi.remove(editId);
      setShowEditModal(false);
      fetchRows();
      alert('Deleted.');
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const parsedBulk = useMemo(() => parsePastedStockRows(bulkData), [bulkData]);

  const previewBulk = () => {
    const bad = parsedBulk.filter(
      (r) =>
        !r.transaction_date ||
        !r.part_number ||
        !r.rack_location ||
        !Number.isFinite(r.qty_in) ||
        !(r.qty_in > 0)
    );
    if (bad.length && parsedBulk.length) {
      alert(`${bad.length} row(s) missing date/part/rack or invalid qty_in — fix before import. Showing preview anyway.`);
    }
    setBulkPreview(parsedBulk.slice(0, 20));
  };

  const importBulk = async ({ updateExisting }) => {
    try {
      const invalid = parsedBulk.filter(
        (r) =>
          !r.transaction_date ||
          !r.part_number ||
          !r.rack_location ||
          !Number.isFinite(r.qty_in) ||
          !(r.qty_in > 0)
      );
      if (invalid.length) {
        alert('Cannot import: every row needs transaction_date, part_number, rack_location and numeric qty_in > 0.');
        return;
      }
      await stockInApi.bulkPaste(parsedBulk, { update_existing: updateExisting });
      setShowBulkModal(false);
      setBulkData('');
      setBulkPreview([]);
      fetchRows();
      alert('Bulk import completed.');
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const onUploadFile = async (file, { updateExisting }) => {
    try {
      const summary = await stockInApi.upload(file, { update_existing: updateExisting });
      fetchRows();
      reportUploadResult(summary, { label: 'Stock In upload', filenamePrefix: 'stock-in-upload' });
    } catch (e) {
      reportUploadError(e, { label: 'Stock In upload', filenamePrefix: 'stock-in-upload' });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadTemplate = () => {
    const header = [
      'transaction_date',
      'vendor_name',
      'part_number',
      'sap_part_number',
      'description',
      'uom',
      'rack_location',
      'qty_in',
      'source_type',
      'reference_no',
      'remarks',
    ];
    const sample = [
      {
        transaction_date: '2026-04-28',
        vendor_name: 'Schneider',
        part_number: 'C25F3TM250C',
        sap_part_number: 'SAP001',
        description: 'Breaker',
        uom: 'PCS',
        rack_location: '241A',
        qty_in: 8,
        source_type: 'txt_scan',
        reference_no: 'RACKSCAN001',
        remarks: 'Opening rack scan',
      },
      {
        transaction_date: '2026-04-28',
        part_number: 'C16F32D160',
        sap_part_number: 'SAP002',
        description: 'Breaker',
        rack_location: '241A',
        qty_in: 15,
        source_type: 'txt_scan',
        reference_no: 'RACKSCAN001',
        remarks: 'Opening rack scan',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sample, { header });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock In');
    XLSX.writeFile(wb, 'stock-in-template.xlsx');
  };

  return (
    <div>
      <div className="app-page-toolbar">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className="btn-primary flex items-center gap-1" onClick={openCreate}>
            <Plus size={14} />
            Add Stock In
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={downloadTemplate}>
            <Download size={14} />
            Download sample template
          </button>
          <label className="btn-secondary flex items-center gap-1 cursor-pointer">
            <Upload size={14} />
            Upload Excel/CSV
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadFile(f, { updateExisting: false });
              }}
            />
          </label>
          <label className="btn-secondary flex items-center gap-1 cursor-pointer">
            <Upload size={14} />
            Upload (Update Existing)
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadFile(f, { updateExisting: true });
              }}
            />
          </label>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => setShowBulkModal(true)}>
            <Copy size={14} />
            Copy-paste bulk entry
          </button>
          <button
            type="button"
            className="btn-secondary flex items-center gap-1"
            onClick={() =>
              exportJsonToExcel(
                (displayRows || []).map((r) => ({
                  'Transaction Date': r.transaction_date,
                  Vendor: r.vendor_name || '',
                  'Part Number': r.part_number,
                  'SAP Part Number': r.sap_part_number,
                  Description: r.description,
                  UOM: r.uom,
                  Rack: r.rack_location,
                  'Qty In': r.qty_in,
                  'Source Type': r.source_type,
                  'Reference No': r.reference_no,
                  Remarks: r.remarks,
                })),
                'stock-in-export.xlsx',
                'Stock In'
              )
            }
          >
            <FileDown size={14} />
            Export Excel
          </button>
        </div>
      </div>

      {loading ? (
        <div>Loading Stock In…</div>
      ) : (
        <div className="table-container">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <SortTh columnKey="transaction_date" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Transaction Date
                </SortTh>
                <SortTh columnKey="vendor_name" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Vendor
                </SortTh>
                <SortTh columnKey="part_number" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Part Number
                </SortTh>
                <SortTh columnKey="sap_part_number" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  SAP PN
                </SortTh>
                <SortTh columnKey="description" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Description
                </SortTh>
                <SortTh columnKey="uom" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  UOM
                </SortTh>
                <SortTh columnKey="rack_location" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Rack
                </SortTh>
                <SortTh columnKey="qty_in" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Qty In
                </SortTh>
                <SortTh columnKey="source_type" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Source Type
                </SortTh>
                <SortTh columnKey="reference_no" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Reference No
                </SortTh>
                <SortTh columnKey="remarks" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Remarks
                </SortTh>
                <th className="tbl-th">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(displayRows || []).map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="tbl-td-nowrap">{formatDateDDMMYYYY(r.transaction_date)}</td>
                  <td className="tbl-td-nowrap">{r.vendor_name || '-'}</td>
                  <td className="tbl-td-nowrap">{r.part_number}</td>
                  <td className="tbl-td-nowrap">{r.sap_part_number || '-'}</td>
                  <td className="tbl-td">{r.description || '-'}</td>
                  <td className="tbl-td-nowrap">{r.uom || '-'}</td>
                  <td className="tbl-td-nowrap">{r.rack_location}</td>
                  <td className="tbl-td-nowrap">{r.qty_in}</td>
                  <td className="tbl-td-nowrap">{r.source_type || '-'}</td>
                  <td className="tbl-td-nowrap">{r.reference_no || '-'}</td>
                  <td className="tbl-td">{r.remarks || '-'}</td>
                  <td className="tbl-td-nowrap">
                    <div className="flex items-center gap-1">
                      <button type="button" className="btn-secondary !py-1 !px-1.5" onClick={() => openEdit(r)} title="Edit">
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-secondary !py-1 !px-1.5"
                        onClick={() => openEdit(r)}
                        title="Delete"
                      >
                        <Trash2 size={14} className="text-red-600" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showEditModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">{editId ? 'Edit Stock In' : 'Add Stock In'}</h3>
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowEditModal(false);
                  setEditId(null);
                }}
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-[11px] font-bold md:col-span-2">
                Vendor
                <select
                  className="input-field mt-1"
                  value={form.vendor_id}
                  onChange={(e) => onVendorPick(e.target.value)}
                >
                  <option value="">Select vendor…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.vendor_name}
                      {v.vendor_number ? ` (${v.vendor_number})` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-[11px] font-bold">
                Part Number
                {vendorItems.length ? (
                  <select
                    className="input-field mt-1"
                    value={form.part_number}
                    onChange={(e) => onPartPick(e.target.value)}
                    disabled={!!editId}
                  >
                    <option value="">{loadingVendorItems ? 'Loading…' : 'Select part number…'}</option>
                    {vendorItems.map((item) => (
                      <option key={item.id} value={item.part_number}>
                        {item.part_number}
                        {item.description ? ` — ${item.description}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input-field mt-1"
                    value={form.part_number}
                    onChange={(e) => setForm((f) => ({ ...f, part_number: e.target.value }))}
                    placeholder="Enter part number"
                    disabled={!!editId}
                  />
                )}
              </label>

              <label className="text-[11px] font-bold">
                Quantity
                <input
                  className="input-field mt-1"
                  type="number"
                  min="0"
                  step="any"
                  value={form.qty_in}
                  onChange={(e) => setForm((f) => ({ ...f, qty_in: e.target.value }))}
                  placeholder="Qty in"
                />
              </label>

              <label className="text-[11px] font-bold md:col-span-2">
                Description
                <input
                  className="input-field mt-1"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Description"
                />
              </label>

              <label className="text-[11px] font-bold">
                UOM
                <input
                  className="input-field mt-1"
                  value={form.uom}
                  onChange={(e) => setForm((f) => ({ ...f, uom: e.target.value }))}
                  placeholder="e.g. PCS"
                />
              </label>

              <label className="text-[11px] font-bold">
                SAP Part Number
                <input
                  className="input-field mt-1"
                  value={form.sap_part_number}
                  onChange={(e) => setForm((f) => ({ ...f, sap_part_number: e.target.value }))}
                  placeholder="SAP part number"
                />
              </label>

              <label className="text-[11px] font-bold">
                Transaction Date
                <input
                  className="input-field mt-1"
                  type="date"
                  value={form.transaction_date}
                  onChange={(e) => setForm((f) => ({ ...f, transaction_date: e.target.value }))}
                />
              </label>

              <label className="text-[11px] font-bold">
                Rack Location
                <input
                  className="input-field mt-1"
                  value={form.rack_location}
                  onChange={(e) => setForm((f) => ({ ...f, rack_location: e.target.value }))}
                  placeholder="Rack location"
                  disabled={!!editId}
                />
              </label>

              <label className="text-[11px] font-bold">
                Source Type
                <input
                  className="input-field mt-1"
                  value={form.source_type}
                  onChange={(e) => setForm((f) => ({ ...f, source_type: e.target.value }))}
                  placeholder="Source type"
                />
              </label>

              <label className="text-[11px] font-bold">
                Reference No
                <input
                  className="input-field mt-1"
                  value={form.reference_no}
                  onChange={(e) => setForm((f) => ({ ...f, reference_no: e.target.value }))}
                  placeholder="Reference no"
                />
              </label>

              <label className="text-[11px] font-bold md:col-span-2">
                Remarks
                <input
                  className="input-field mt-1"
                  value={form.remarks}
                  onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                  placeholder="Remarks"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-3 mt-6">
              <button className="btn-primary flex-1" onClick={submitSingle}>
                {editId ? 'Save Changes' : 'Save'}
              </button>
              {editId ? (
                <button className="btn-secondary flex items-center gap-2" onClick={deleteRow}>
                  <Trash2 size={18} className="text-red-600" />
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {showBulkModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[80vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-2">Copy-Paste Bulk Stock In</h3>
            <p className="text-sm text-gray-600 mb-4">
              Paste tab-separated (from Excel) or comma-separated rows. Header optional.
              <br />
              <span className="font-mono text-xs">
                Rack scan TXT (8): transaction_date, part_number, sap_part_number, rack_location, qty_in, source_type,
                reference_no, remarks
              </span>
              <br />
              <span className="font-mono text-xs text-gray-500">
                Legacy (9): includes description after sap_part_number.
              </span>
            </p>
            <textarea
              value={bulkData}
              onChange={(e) => setBulkData(e.target.value)}
              className="input-field h-56 font-mono text-sm resize-none"
              placeholder="Paste your tab-separated rows here..."
            />

            {bulkPreview.length ? (
              <div className="mt-4 border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase">
                  Preview (first 20)
                </div>
                <div className="p-4 text-sm text-gray-700 space-y-1">
                  {bulkPreview.map((r, idx) => (
                    <div key={idx} className="font-mono text-xs">
                      {formatDateDDMMYYYY(r.transaction_date)} | {r.part_number} | {r.rack_location} | in:{r.qty_in}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3 mt-6">
              <button onClick={previewBulk} className="btn-secondary flex items-center gap-2">
                <Eye size={18} />
                Preview
              </button>
              <button onClick={() => importBulk({ updateExisting: false })} className="btn-primary flex-1">
                Import
              </button>
              <button onClick={() => importBulk({ updateExisting: true })} className="btn-secondary flex-1">
                Update Existing
              </button>
              <button
                onClick={() => {
                  setBulkData('');
                  setBulkPreview([]);
                }}
                className="btn-secondary"
              >
                Clear
              </button>
              <button
                onClick={() => {
                  setShowBulkModal(false);
                  setBulkPreview([]);
                }}
                className="btn-secondary px-8"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StockIn;
