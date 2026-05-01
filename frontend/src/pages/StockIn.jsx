import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Eye, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import * as XLSX from 'xlsx';
import { stockInApi } from '../services/api';

function downloadErrorWorkbook({ failed, filename }) {
  const rows = (failed || []).map((r) => ({
    row_index: r.row_index,
    error: r.error,
    ...(r.row || {}),
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Errors');
  XLSX.writeFile(wb, filename);
}

/** Tab-separated (Excel paste) or comma-separated TXT/CSV; delimiter chosen per line. */
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
    const qtyRaw = cols[5];
    const qtyNum = parseFloat(String(qtyRaw || '').replace(/,/g, ''));
    return {
      transaction_date: (cols[0] || '').trim(),
      part_number: (cols[1] || '').trim(),
      sap_part_number: (cols[2] || '').trim(),
      description: (cols[3] || '').trim(),
      rack_location: (cols[4] || '').trim(),
      qty_in: Number.isFinite(qtyNum) ? qtyNum : NaN,
      source_type: (cols[6] || '').trim(),
      reference_no: (cols[7] || '').trim(),
      remarks: (cols[8] || '').trim(),
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
    part_number: '',
    sap_part_number: '',
    description: '',
    rack_location: '',
    qty_in: '',
    source_type: '',
    reference_no: '',
    remarks: '',
  });

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

  const openCreate = () => {
    setEditId(null);
    setForm({
      transaction_date: new Date().toISOString().slice(0, 10),
      part_number: '',
      sap_part_number: '',
      description: '',
      rack_location: '',
      qty_in: '',
      source_type: '',
      reference_no: '',
      remarks: '',
    });
    setShowEditModal(true);
  };

  const openEdit = (row) => {
    setEditId(row.id);
    setForm({
      transaction_date: String(row.transaction_date || '').slice(0, 10),
      part_number: row.part_number || '',
      sap_part_number: row.sap_part_number || '',
      description: row.description || '',
      rack_location: row.rack_location || '',
      qty_in: String(row.qty_in ?? ''),
      source_type: row.source_type || '',
      reference_no: row.reference_no || '',
      remarks: row.remarks || '',
    });
    setShowEditModal(true);
  };

  const submitSingle = async () => {
    try {
      const payload = {
        ...form,
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
      await stockInApi.upload(file, { update_existing: updateExisting });
      fetchRows();
      alert('Upload import completed.');
    } catch (e) {
      const data = e.response?.data;
      const msg = data?.error || e.message;
      const results = Array.isArray(data?.results) ? data.results : null;
      const failed = results ? results.filter((r) => r && r.error) : [];
      if (failed.length) {
        downloadErrorWorkbook({
          failed,
          filename: `stock-in-upload-errors-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.xlsx`,
        });
        alert(`${msg}\n\nDownloaded an error-only Excel with ${failed.length} row(s) and an 'error' column.`);
      } else {
        alert(msg);
      }
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadTemplate = () => {
    const header = [
      'transaction_date',
      'part_number',
      'sap_part_number',
      'description',
      'rack_location',
      'qty_in',
      'source_type',
      'reference_no',
      'remarks',
    ];
    const sample = [
      {
        transaction_date: '2026-04-28',
        part_number: 'C25F3TM250C',
        sap_part_number: 'SAP001',
        description: 'Breaker',
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
        </div>
      </div>

      {loading ? (
        <div>Loading Stock In…</div>
      ) : (
        <div className="table-container">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="tbl-th">
                  Transaction Date
                </th>
                <th className="tbl-th">
                  Part Number
                </th>
                <th className="tbl-th">SAP PN</th>
                <th className="tbl-th">
                  Description
                </th>
                <th className="tbl-th">
                  Rack
                </th>
                <th className="tbl-th">
                  Qty In
                </th>
                <th className="tbl-th">
                  Source Type
                </th>
                <th className="tbl-th">
                  Reference No
                </th>
                <th className="tbl-th">
                  Remarks
                </th>
                <th className="tbl-th">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(rows || []).map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="tbl-td-nowrap">
                    {String(r.transaction_date).slice(0, 10)}
                  </td>
                  <td className="tbl-td-nowrap">{r.part_number}</td>
                  <td className="tbl-td-nowrap">{r.sap_part_number || '-'}</td>
                  <td className="tbl-td">{r.description || '-'}</td>
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

      {/* Create/Edit Modal */}
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

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <input
                className="input-field"
                type="date"
                value={form.transaction_date}
                onChange={(e) => setForm((f) => ({ ...f, transaction_date: e.target.value }))}
                placeholder="transaction_date"
              />
              <input
                className="input-field"
                value={form.part_number}
                onChange={(e) => setForm((f) => ({ ...f, part_number: e.target.value }))}
                placeholder="part_number"
                disabled={!!editId}
              />
              <input
                className="input-field"
                value={form.sap_part_number}
                onChange={(e) => setForm((f) => ({ ...f, sap_part_number: e.target.value }))}
                placeholder="sap_part_number"
              />
              <input
                className="input-field"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="description"
              />
              <input
                className="input-field"
                value={form.rack_location}
                onChange={(e) => setForm((f) => ({ ...f, rack_location: e.target.value }))}
                placeholder="rack_location"
                disabled={!!editId}
              />
              <input
                className="input-field"
                value={form.qty_in}
                onChange={(e) => setForm((f) => ({ ...f, qty_in: e.target.value }))}
                placeholder="qty_in"
              />
              <input
                className="input-field"
                value={form.source_type}
                onChange={(e) => setForm((f) => ({ ...f, source_type: e.target.value }))}
                placeholder="source_type"
              />
              <input
                className="input-field"
                value={form.reference_no}
                onChange={(e) => setForm((f) => ({ ...f, reference_no: e.target.value }))}
                placeholder="reference_no"
              />
              <input
                className="input-field"
                value={form.remarks}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                placeholder="remarks"
              />
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

      {/* Bulk Paste Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[80vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-2">Copy-Paste Bulk Stock In</h3>
            <p className="text-sm text-gray-600 mb-4">
              Paste tab-separated (from Excel) or comma-separated rows. Header optional.
              <br />
              transaction_date, part_number, sap_part_number, description, rack_location, qty_in, source_type,
              reference_no, remarks
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
                      {r.transaction_date} | {r.part_number} | {r.rack_location} | in:{r.qty_in}
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

