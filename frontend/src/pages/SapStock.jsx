import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, History, Download, Trash2, FileSpreadsheet, RefreshCw, X } from 'lucide-react';
import { sapStockApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : String(Number(v.toFixed(4)));
}

export default function SapStock() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [batchId, setBatchId] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [detailMaterial, setDetailMaterial] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await sapStockApi.list({ search: search.trim(), limit: 3000, offset: 0 });
      setRows(data.rows || []);
      setTotal(data.total ?? 0);
      setBatchId(data.batch_id ?? null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to load');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => load(), 320);
    return () => clearTimeout(t);
  }, [search, load]);

  const sortValue = useCallback((r, k) => {
    if (k === 'sap_qty') return Number(r.sap_qty) || 0;
    return r[k];
  }, []);
  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, sortValue);

  const onUpload = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUploadBusy(true);
    setErr('');
    try {
      const summary = await sapStockApi.upload(f);
      window.alert(
        `Upload complete.\nRows: ${summary.total_rows}\nUnique materials: ${summary.unique_materials}\n` +
          `Qty 1002 (transit): ${fmtNum(summary.qty_1002)}\nQty 1004: ${fmtNum(summary.qty_1004)}\nQty 1007: ${fmtNum(summary.qty_1007)}`
      );
      await load();
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message || 'Upload failed');
    } finally {
      setUploadBusy(false);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    try {
      const data = await sapStockApi.uploadHistory();
      setHistoryRows(data.rows || []);
    } catch {
      setHistoryRows([]);
    }
  };

  const exportSap = async () => {
    try {
      await sapStockApi.exportExcel();
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message || 'Export failed');
    }
  };

  const clearLatest = async () => {
    if (!window.confirm('Delete the most recent SAP upload and its rows? Main stock SAP qty will be recalculated from the previous upload, or cleared if none.')) {
      return;
    }
    setErr('');
    try {
      await sapStockApi.clearLatestUpload();
      await load();
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message || 'Clear failed');
    }
  };

  const openDetail = async (material) => {
    setDetailMaterial(material);
    setDetail(null);
    try {
      const data = await sapStockApi.details(material);
      setDetail(data);
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message || 'Failed to load details');
    }
  };

  return (
    <div className="max-w-[1920px] mx-auto px-2 sm:px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h1 className="text-sm font-black text-gray-900 tracking-tight">SAP Stock</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onUpload} />
          <button
            type="button"
            disabled={uploadBusy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary-600 text-white text-[11px] font-bold hover:bg-primary-700 disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            {uploadBusy ? 'Uploading…' : 'Upload SAP Stock Excel'}
          </button>
          <button
            type="button"
            onClick={openHistory}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <History className="w-3.5 h-3.5" />
            View Upload History
          </button>
          <button
            type="button"
            onClick={exportSap}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export SAP Stock
          </button>
          <button
            type="button"
            onClick={() => sapStockApi.downloadTemplate()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Template
          </button>
          <button
            type="button"
            onClick={clearLatest}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-red-200 bg-red-50 text-[11px] font-bold text-red-800 hover:bg-red-100"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear Latest Upload
          </button>
          <button
            type="button"
            onClick={() => load()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-600 mb-2">
        Latest processed upload (batch #{batchId ?? '—'}). SAP quantities are for comparison only; main stock available qty is unchanged on upload.
      </p>

      {err ? <div className="mb-2 text-[11px] font-bold text-red-700">{err}</div> : null}

      <div className="flex items-center gap-2 mb-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search part, description, vendor, material group…"
          className="flex-1 min-w-[160px] max-w-md border border-gray-300 rounded-md px-2 py-1 text-[11px]"
        />
        <span className="text-[10px] text-gray-500 whitespace-nowrap">{total} row(s)</span>
      </div>

      <div className="border border-gray-200 rounded-lg overflow-auto bg-white">
        <table className="min-w-full text-[11px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <SortTh label="Vendor #" k="vendor_number" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="Material / SAP Part" k="material" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="Description" k="description" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="SL" k="storage_location" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="SL Desc" k="storage_location_description" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="SAP Qty" k="sap_qty" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="UOM" k="base_uom" sortKey={sortKey} direction={direction} onSort={requestSort} />
              <SortTh label="Mat. Group" k="material_group" sortKey={sortKey} direction={direction} onSort={requestSort} />
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : null}
            {!loading && !displayRows.length ? (
              <tr>
                <td colSpan={8} className="p-4 text-center text-gray-500">
                  No SAP upload data yet. Upload an Excel file to begin.
                </td>
              </tr>
            ) : null}
            {displayRows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-gray-100 hover:bg-primary-50/40 cursor-pointer"
                onClick={() => openDetail(r.material)}
              >
                <td className="px-2 py-1 whitespace-nowrap">{r.vendor_number ?? '—'}</td>
                <td className="px-2 py-1 font-mono font-bold text-primary-800">{r.material}</td>
                <td className="px-2 py-1 max-w-[220px] truncate" title={r.description}>
                  {r.description ?? '—'}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">{r.storage_location ?? '—'}</td>
                <td className="px-2 py-1 max-w-[160px] truncate">{r.storage_location_description ?? '—'}</td>
                <td className="px-2 py-1 text-right font-mono">{fmtNum(r.sap_qty)}</td>
                <td className="px-2 py-1">{r.base_uom ?? '—'}</td>
                <td className="px-2 py-1">{r.material_group ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {historyOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setHistoryOpen(false)}>
          <div
            className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
              <h2 className="text-[12px] font-black">Upload history</h2>
              <button type="button" className="p-1 rounded hover:bg-gray-100" onClick={() => setHistoryOpen(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-auto p-2 text-[11px]">
              <table className="min-w-full">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-1 pr-2">ID</th>
                    <th className="py-1 pr-2">File</th>
                    <th className="py-1 pr-2">Date</th>
                    <th className="py-1 pr-2">Rows</th>
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">By</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((h) => (
                    <tr key={h.id} className="border-b border-gray-100">
                      <td className="py-1 pr-2">{h.id}</td>
                      <td className="py-1 pr-2 max-w-[200px] truncate">{h.file_name}</td>
                      <td className="py-1 pr-2 whitespace-nowrap">{h.upload_date}</td>
                      <td className="py-1 pr-2">{h.total_rows}</td>
                      <td className="py-1 pr-2">{h.status}</td>
                      <td className="py-1 pr-2">{h.uploaded_by_username || h.uploaded_by || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {detailMaterial ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDetailMaterial('')}>
          <div
            className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 sticky top-0 bg-white">
              <h2 className="text-[12px] font-black">SAP line detail — {detailMaterial}</h2>
              <button type="button" className="p-1 rounded hover:bg-gray-100" onClick={() => setDetailMaterial('')}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 text-[11px] space-y-3">
              {!detail ? <div className="text-gray-500">Loading…</div> : null}
              {(detail?.rows || []).map((line) => (
                <div key={line.id} className="border border-gray-200 rounded-md p-2 space-y-1">
                  <div>
                    <span className="text-gray-500">Vendor</span> {line.vendor_number ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Material</span> {line.material}
                  </div>
                  <div>
                    <span className="text-gray-500">Description</span> {line.description ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Storage</span> {line.storage_location} — {line.storage_location_description ?? ''}
                  </div>
                  <div>
                    <span className="text-gray-500">Stock</span> {fmtNum(line.stock_qty)}
                  </div>
                  <div>
                    <span className="text-gray-500">Storage document</span> {line.storage_document ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Batch</span> {line.batch ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Unrestricted qty</span> {fmtNum(line.unrestricted_qty)}
                  </div>
                  <div>
                    <span className="text-gray-500">Base UOM</span> {line.base_uom ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Value</span> {fmtNum(line.value_amount)}
                  </div>
                  <div>
                    <span className="text-gray-500">Material group</span> {line.material_group ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Upload batch</span> #{line.upload_batch_id} — {line.batch_file_name}
                  </div>
                  <div>
                    <span className="text-gray-500">Upload date</span> {line.batch_upload_date ?? '—'} ·{' '}
                    <span className="text-gray-500">Uploaded at</span> {line.uploaded_at ?? '—'}
                  </div>
                </div>
              ))}
              {detail && !(detail.rows || []).length ? <div className="text-gray-500">No lines for this material in the latest batch.</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
