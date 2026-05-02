import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Plus, Search, Upload, Eye, Trash2 } from 'lucide-react';
import { vendorsApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

const HEADERS = ['Vendor Number', 'Vendor Name', 'Contact Person', 'Phone Number', 'Email', 'Remarks'];
const VENDOR_KEYS = ['vendor_number', 'vendor_name', 'contact_person', 'phone_number', 'email', 'remarks'];

export default function VendorMaster() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    vendor_number: '',
    vendor_name: '',
    contact_person: '',
    phone_number: '',
    email: '',
    remarks: '',
    is_active: 1,
  });

  const [showBulk, setShowBulk] = useState(false);
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);

  const fileRef = useRef(null);

  const fetchRows = async (q = '') => {
    try {
      setLoading(true);
      const data = await vendorsApi.list(q);
      setRows(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchRows(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const tableRows = useMemo(() => rows || [], [rows]);

  const vendorSortValue = useCallback((row, key) => {
    if (key === 'is_active') return Number(row.is_active) ? 1 : 0;
    return row?.[key];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(tableRows, vendorSortValue);

  const resetForm = () => {
    setForm({
      vendor_number: '',
      vendor_name: '',
      contact_person: '',
      phone_number: '',
      email: '',
      remarks: '',
      is_active: 1,
    });
  };

  const save = async () => {
    try {
      if (!String(form.vendor_name || '').trim()) return alert('Vendor Name is required');
      await vendorsApi.create(form);
      setShowAdd(false);
      resetForm();
      fetchRows(search);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const parseBulk = () => {
    const lines = bulkData.trim().split('\n').filter((l) => l.trim());
    return lines.map((line) => {
      const c = line.includes('\t') ? line.split('\t') : line.split(',').map((x) => x.trim());
      return {
        vendor_number: c[0] || '',
        vendor_name: c[1] || '',
        contact_person: c[2] || '',
        phone_number: c[3] || '',
        email: c[4] || '',
        remarks: c[5] || '',
        is_active: 1,
      };
    });
  };

  const previewBulk = () => setBulkPreview(parseBulk().slice(0, 20));

  const importBulk = async () => {
    try {
      const data = parseBulk();
      await vendorsApi.bulkPaste(data);
      setShowBulk(false);
      setBulkData('');
      setBulkPreview([]);
      fetchRows(search);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const onUpload = async (file) => {
    try {
      await vendorsApi.upload(file);
      fetchRows(search);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deactivate = async (id) => {
    if (!confirm('Deactivate this vendor?')) return;
    try {
      await vendorsApi.remove(id);
      fetchRows(search);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-start justify-between mb-2 gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-900 leading-tight">Vendor Master</h2>
          <p className="text-[11px] text-gray-600">Admin only</p>
        </div>
        <div className="flex gap-1.5 flex-wrap justify-end">
          <button
            type="button"
            className="btn-primary flex items-center gap-1"
            onClick={() => {
              resetForm();
              setShowAdd(true);
            }}
          >
            <Plus size={14} />
            Add Vendor
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => vendorsApi.downloadTemplateXlsx()}>
            <Download size={14} />
            Download Template
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
                if (f) onUpload(f);
              }}
            />
          </label>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => setShowBulk(true)}>
            <Copy size={14} />
            Bulk Paste
          </button>
        </div>
      </div>

      <div className="app-page-toolbar">
        <div className="flex items-center gap-2 max-w-xl">
          <Search size={14} className="text-gray-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search vendor number/name..."
            className="input-field flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="table-container">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {HEADERS.map((h, i) => (
                <SortTh key={h} columnKey={VENDOR_KEYS[i]} sortKey={sortKey} direction={direction} onSort={requestSort}>
                  {h}
                </SortTh>
              ))}
              <SortTh columnKey="is_active" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Active
              </SortTh>
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={HEADERS.length + 2}>
                  Loading…
                </td>
              </tr>
            ) : null}
            {displayRows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{r.vendor_number || ''}</td>
                <td className="tbl-td-nowrap">{r.vendor_name || ''}</td>
                <td className="tbl-td-nowrap">{r.contact_person || ''}</td>
                <td className="tbl-td-nowrap">{r.phone_number || ''}</td>
                <td className="tbl-td-nowrap">{r.email || ''}</td>
                <td className="tbl-td">{r.remarks || ''}</td>
                <td className="tbl-td-nowrap">{r.is_active ? 'Yes' : 'No'}</td>
                <td className="tbl-td-nowrap">
                  <button type="button" className="text-red-600 hover:text-red-800 p-0.5" onClick={() => deactivate(r.id)} title="Deactivate">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && !displayRows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={HEADERS.length + 2}>
                  No vendors found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {showAdd ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-bold">Add Vendor</h3>
              <button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold">
                Vendor Number
                <input className="input-field mt-1" value={form.vendor_number} onChange={(e) => setForm((s) => ({ ...s, vendor_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Vendor Name
                <input className="input-field mt-1" value={form.vendor_name} onChange={(e) => setForm((s) => ({ ...s, vendor_name: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Contact Person
                <input className="input-field mt-1" value={form.contact_person} onChange={(e) => setForm((s) => ({ ...s, contact_person: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Phone Number
                <input className="input-field mt-1" value={form.phone_number} onChange={(e) => setForm((s) => ({ ...s, phone_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Email
                <input className="input-field mt-1" value={form.email} onChange={(e) => setForm((s) => ({ ...s, email: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Remarks
                <textarea className="input-field mt-1 h-16" value={form.remarks} onChange={(e) => setForm((s) => ({ ...s, remarks: e.target.value }))} />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={save}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showBulk ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[80vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-2">Bulk Paste Vendors</h3>
            <p className="text-sm text-gray-600 mb-4">Paste tab-separated rows in this order:</p>
            <textarea className="input-field h-48 font-mono text-sm resize-none" value={bulkData} onChange={(e) => setBulkData(e.target.value)} placeholder={HEADERS.join('\t')} />
            {bulkPreview.length ? (
              <div className="mt-4 border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase">Preview (first 20)</div>
                <div className="p-4 text-sm text-gray-700 space-y-1">
                  {bulkPreview.map((r, idx) => (
                    <div key={idx} className="font-mono text-xs">
                      {r.vendor_number || '(blank)'} | {r.vendor_name}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3 mt-6">
              <button onClick={previewBulk} className="btn-secondary flex items-center gap-2">
                <Eye size={18} /> Preview Data
              </button>
              <button onClick={importBulk} className="btn-primary flex-1">
                Import / Update (Upsert)
              </button>
              <button
                onClick={() => {
                  setShowBulk(false);
                  setBulkPreview([]);
                }}
                className="btn-secondary px-8"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

