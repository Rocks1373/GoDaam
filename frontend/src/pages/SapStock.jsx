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
  const [filterStorageLocation, setFilterStorageLocation] = useState('');
  const [filterMaterialGroup, setFilterMaterialGroup] = useState('');
  const [filterMaterial, setFilterMaterial] = useState('');
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
      const data = await sapStockApi.list({
        storage_location: filterStorageLocation.trim(),
        material_group: filterMaterialGroup.trim(),
        material: filterMaterial.trim(),
        limit: 3000,
        offset: 0,
      });
      setRows(data.rows || []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to load');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filterStorageLocation, filterMaterialGroup, filterMaterial]);

  useEffect(() => {
    const t = setTimeout(() => load(), 320);
    return () => clearTimeout(t);
  }, [filterStorageLocation, filterMaterialGroup, filterMaterial, load]);

  const sortValue = useCallback((r, k) => {
    if (k === 'quantity') return Number(r.quantity ?? r.unrestricted_qty) || 0;
    if (k === 'sap_qty' || k === 'unrestricted_qty' || k === 'stock_qty') return Number(r[k]) || 0;
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
      const layout =
        summary.layout_mode === 'wide' && summary.layout_columns?.unrestricted
          ? `wide · Unrestricted→column ${summary.layout_columns.unrestricted} · header row ${summary.layout_columns.header_row_1based}`
          : `${summary.layout_mode || 'legacy'} · ${summary.layout_columns?.mode || 'fixed indices'}`;
      window.alert(
        `Upload complete.\nRows: ${summary.total_rows}\nUnique materials: ${summary.unique_materials}\n` +
          `Parse layout: ${layout}\n` +
          `Qty SL → 1001: ${fmtNum(summary.qty_1001)} · 1002: ${fmtNum(summary.qty_1002)} · 1003: ${fmtNum(summary.qty_1003)}\n` +
          `1004: ${fmtNum(summary.qty_1004)} · 1005: ${fmtNum(summary.qty_1005)} · 1007: ${fmtNum(summary.qty_1007)}`
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

      {err ? <div className="mb-2 text-[11px] font-bold text-red-700">{err}</div> : null}

      <div className="flex flex-wrap items-end gap-2 mb-2">
        <label className="flex flex-col gap-0.5 min-w-[120px] flex-1 max-w-[200px]">
          <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">Storage location</span>
          <input
            value={filterStorageLocation}
            onChange={(e) => setFilterStorageLocation(e.target.value)}
            placeholder="e.g. 1002"
            className="w-full border border-gray-300 rounded-md px-2 py-1 text-[11px]"
          />
        </label>
        <label className="flex flex-col gap-0.5 min-w-[120px] flex-1 max-w-[200px]">
          <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">Material group</span>
          <input
            value={filterMaterialGroup}
            onChange={(e) => setFilterMaterialGroup(e.target.value)}
            placeholder="Group code"
            className="w-full border border-gray-300 rounded-md px-2 py-1 text-[11px]"
          />
        </label>
        <label className="flex flex-col gap-0.5 min-w-[140px] flex-1 max-w-[220px]">
          <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">Material</span>
          <input
            value={filterMaterial}
            onChange={(e) => setFilterMaterial(e.target.value)}
            placeholder="Material / SAP part"
            className="w-full border border-gray-300 rounded-md px-2 py-1 text-[11px]"
          />
        </label>
        <span className="text-[10px] text-gray-500 whitespace-nowrap pb-1">{total} row(s)</span>
      </div>

      <div className="border border-gray-200 rounded-lg overflow-auto bg-white">
        <table className="min-w-full text-[11px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <SortTh
                bare
                columnKey="material_group"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Mat. group
              </SortTh>
              <SortTh
                bare
                columnKey="item_sd"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Item (SD)
              </SortTh>
              <SortTh
                bare
                columnKey="material"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Material
              </SortTh>
              <SortTh
                bare
                columnKey="description"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Description
              </SortTh>
              <SortTh
                bare
                columnKey="sales_document"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Sales document
              </SortTh>
              <SortTh
                bare
                columnKey="accessories"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Accessories
              </SortTh>
              <SortTh
                bare
                columnKey="batch"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Batch
              </SortTh>
              <SortTh
                bare
                columnKey="storage_location"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Storage loc.
              </SortTh>
              <SortTh
                bare
                columnKey="storage_location_description"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                SL description
              </SortTh>
              <SortTh
                bare
                columnKey="quantity"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-right text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                Quantity
              </SortTh>
              <SortTh
                bare
                columnKey="base_uom"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 text-left text-[10px] font-extrabold text-gray-800 uppercase tracking-wide"
              >
                UOM
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length ? (
              <tr>
                <td colSpan={11} className="p-4 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : null}
            {!loading && !displayRows.length ? (
              <tr>
                <td colSpan={11} className="p-4 text-center text-gray-500">
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
                <td className="px-2 py-1 font-mono text-[10px]" title={r.material_group ?? ''}>
                  {r.material_group ?? '—'}
                </td>
                <td className="px-2 py-1 font-mono text-[10px] whitespace-nowrap" title={r.item_sd ?? ''}>
                  {r.item_sd ?? '—'}
                </td>
                <td className="px-2 py-1 font-mono font-bold text-primary-800">{r.material}</td>
                <td className="px-2 py-1 max-w-[220px] truncate" title={r.description}>
                  {r.description ?? '—'}
                </td>
                <td className="px-2 py-1 font-mono text-[10px] max-w-[120px] truncate" title={r.sales_document ?? ''}>
                  {r.sales_document ?? '—'}
                </td>
                <td className="px-2 py-1 max-w-[120px] truncate" title={r.accessories ?? ''}>
                  {r.accessories ?? '—'}
                </td>
                <td className="px-2 py-1 font-mono text-[10px] max-w-[140px] truncate" title={r.batch ?? ''}>
                  {r.batch ?? '—'}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">{r.storage_location ?? '—'}</td>
                <td className="px-2 py-1 max-w-[160px] truncate">{r.storage_location_description ?? '—'}</td>
                <td className="px-2 py-1 text-right font-mono font-semibold text-primary-900">
                  {fmtNum(r.quantity ?? r.unrestricted_qty)}
                </td>
                <td className="px-2 py-1">{r.base_uom ?? '—'}</td>
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
                    <span className="text-gray-500">Item (SD)</span> {line.item_sd ?? '—'}
                  </div>
                  <div>
                    <span className="text-gray-500">Sales document</span> {line.sales_document ?? '—'}
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
