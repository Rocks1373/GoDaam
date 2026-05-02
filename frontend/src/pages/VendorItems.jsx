import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Plus, Search, Upload, Eye, Trash2 } from 'lucide-react';
import { vendorItemsApi, vendorsApi } from '../services/api';

const HEADERS = ['Vendor Number', 'Vendor Name', 'SAP Part Number', 'Part Number', 'Description', 'UOM', 'Remarks'];

export default function VendorItems() {
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [vendorId, setVendorId] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    vendor_id: '',
    vendor_number: '',
    vendor_name: '',
    sap_part_number: '',
    part_number: '',
    description: '',
    uom: '',
    remarks: '',
    is_active: 1,
  });

  const [showBulk, setShowBulk] = useState(false);
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);

  const fileRef = useRef(null);

  const refreshVendors = async () => {
    try {
      const v = await vendorsApi.list('');
      setVendors(Array.isArray(v) ? v.filter((x) => x.is_active) : []);
    } catch {
      setVendors([]);
    }
  };

  const fetchRows = async (q = '', vid = '') => {
    try {
      setLoading(true);
      const data = await vendorItemsApi.list({
        search: q,
        ...(vid ? { vendor_id: vid } : {}),
      });
      setRows(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshVendors();
    fetchRows('', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchRows(search, vendorId), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, vendorId]);

  const tableRows = useMemo(() => rows || [], [rows]);

  const resetForm = () => {
    setForm({
      vendor_id: '',
      vendor_number: '',
      vendor_name: '',
      sap_part_number: '',
      part_number: '',
      description: '',
      uom: '',
      remarks: '',
      is_active: 1,
    });
  };

  const onVendorPick = (idStr) => {
    const id = idStr ? Number(idStr) : null;
    const v = vendors.find((x) => x.id === id);
    setForm((s) => ({
      ...s,
      vendor_id: idStr,
      vendor_number: v?.vendor_number || '',
      vendor_name: v?.vendor_name || '',
    }));
  };

  const save = async () => {
    try {
      if (!String(form.part_number || '').trim()) return alert('Part Number is required');
      if (!String(form.description || '').trim()) return alert('Description is required');
      await vendorItemsApi.create({
        ...form,
        vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
      });
      setShowAdd(false);
      resetForm();
      fetchRows(search, vendorId);
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
        sap_part_number: c[2] || '',
        part_number: c[3] || '',
        description: c[4] || '',
        uom: c[5] || '',
        remarks: c[6] || '',
        is_active: 1,
      };
    });
  };

  const previewBulk = () => setBulkPreview(parseBulk().slice(0, 20));

  const importBulk = async () => {
    try {
      const data = parseBulk();
      await vendorItemsApi.bulkPaste(data);
      setShowBulk(false);
      setBulkData('');
      setBulkPreview([]);
      fetchRows(search, vendorId);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const onUpload = async (file) => {
    try {
      await vendorItemsApi.upload(file);
      fetchRows(search, vendorId);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deactivate = async (id) => {
    if (!confirm('Deactivate this vendor item?')) return;
    try {
      await vendorItemsApi.remove(id);
      fetchRows(search, vendorId);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-start justify-between mb-2 gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-900 leading-tight">Vendor Items</h2>
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
            Add Item
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => vendorItemsApi.downloadTemplateXlsx()}>
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
        <div className="flex flex-col md:flex-row md:items-center gap-2 max-w-3xl">
          <div className="flex items-center gap-2 flex-1">
            <Search size={14} className="text-gray-400 flex-shrink-0" />
            <input
              type="text"
              placeholder="Search by vendor, part number, SAP PN, description..."
              className="input-field flex-1"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="input-field w-64" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.vendor_name} {v.vendor_number ? `(${v.vendor_number})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-container">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {HEADERS.map((h) => (
                <th key={h} className="tbl-th">
                  {h}
                </th>
              ))}
              <th className="tbl-th">Active</th>
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
            {tableRows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{r.vendor_number || ''}</td>
                <td className="tbl-td-nowrap">{r.vendor_name || ''}</td>
                <td className="tbl-td-nowrap">{r.sap_part_number || ''}</td>
                <td className="tbl-td-nowrap">{r.part_number || ''}</td>
                <td className="tbl-td">{r.description || ''}</td>
                <td className="tbl-td-nowrap">{r.uom || ''}</td>
                <td className="tbl-td">{r.remarks || ''}</td>
                <td className="tbl-td-nowrap">{r.is_active ? 'Yes' : 'No'}</td>
                <td className="tbl-td-nowrap">
                  <button type="button" className="text-red-600 hover:text-red-800 p-0.5" onClick={() => deactivate(r.id)} title="Deactivate">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && !tableRows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={HEADERS.length + 2}>
                  No vendor items found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {showAdd ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[86vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-bold">Add Vendor Item</h3>
              <button type="button" className="btn-secondary" onClick={() => setShowAdd(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold sm:col-span-2">
                Vendor
                <select className="input-field mt-1" value={form.vendor_id} onChange={(e) => onVendorPick(e.target.value)}>
                  <option value="">Select vendor…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.vendor_name} {v.vendor_number ? `(${v.vendor_number})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-bold">
                Vendor Number
                <input className="input-field mt-1" value={form.vendor_number} readOnly />
              </label>
              <label className="text-[11px] font-bold">
                Vendor Name
                <input className="input-field mt-1" value={form.vendor_name} readOnly />
              </label>
              <label className="text-[11px] font-bold">
                SAP Part Number
                <input className="input-field mt-1" value={form.sap_part_number} onChange={(e) => setForm((s) => ({ ...s, sap_part_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Part Number
                <input className="input-field mt-1" value={form.part_number} onChange={(e) => setForm((s) => ({ ...s, part_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Description
                <input className="input-field mt-1" value={form.description} onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                UOM
                <input className="input-field mt-1" value={form.uom} onChange={(e) => setForm((s) => ({ ...s, uom: e.target.value }))} />
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
            <h3 className="text-xl font-bold mb-2">Bulk Paste Vendor Items</h3>
            <p className="text-sm text-gray-600 mb-4">Paste tab-separated rows in this order:</p>
            <textarea className="input-field h-48 font-mono text-sm resize-none" value={bulkData} onChange={(e) => setBulkData(e.target.value)} placeholder={HEADERS.join('\t')} />
            {bulkPreview.length ? (
              <div className="mt-4 border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase">Preview (first 20)</div>
                <div className="p-4 text-sm text-gray-700 space-y-1">
                  {bulkPreview.map((r, idx) => (
                    <div key={idx} className="font-mono text-xs">
                      {r.vendor_number || '(blank)'} | {r.part_number} | {r.description}
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

