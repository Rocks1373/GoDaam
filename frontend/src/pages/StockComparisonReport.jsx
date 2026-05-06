import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare, Printer, Download } from 'lucide-react';
import { reportsApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

function downloadCsvFile(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const line = (cells) => cells.map(esc).join(',');
  const body = [line(headers), ...rows.map((row) => line(headers.map((h) => row[h] ?? '')))].join('\n');
  const blob = new Blob(['\ufeff', body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  const v = Number(n);
  return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : String(Number(v.toFixed(4)));
}

export default function StockComparisonReport() {
  const [comparisonType, setComparisonType] = useState('main_vs_sap');
  const [comparisonBase, setComparisonBase] = useState('main_stock');

  useEffect(() => {
    if (comparisonType === 'main_vs_rack') setComparisonBase('main_stock');
  }, [comparisonType]);
  const [storageLocation, setStorageLocation] = useState('1004_1007');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const printRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const base =
        comparisonType === 'main_vs_rack'
          ? 'main_stock'
          : comparisonBase === 'sap_stock'
            ? 'sap_stock'
            : 'main_stock';
      const data = await reportsApi.stockComparison({
        comparison_type: comparisonType,
        comparison_base: base,
        storage_location: storageLocation,
        status,
        search: search.trim(),
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
      });
      setRows(data.rows || []);
      setMeta(data.meta || null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [comparisonType, comparisonBase, storageLocation, status, search, dateFrom, dateTo]);

  useEffect(() => {
    const t = setTimeout(() => load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  const sortValue = useCallback((r, k) => {
    if (String(k).includes('qty') || k === 'difference' || k === 'sap_qty') return Number(r[k]) || 0;
    return r[k];
  }, []);
  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, sortValue);

  const headersForCsv = useMemo(() => {
    if (comparisonType === 'main_vs_rack') {
      return [
        'part_number',
        'sap_part_number',
        'description',
        'main_stock_available_qty',
        'stock_by_rack_available_qty',
        'sap_qty',
        'difference',
        'status',
      ];
    }
    if (comparisonBase === 'sap_stock') {
      return ['sap_material', 'description', 'sap_physical_qty', 'main_stock_qty', 'difference', 'status', 'material_group', 'vendor_number'];
    }
    return [
      'part_number',
      'sap_part_number',
      'description',
      'main_stock_available_qty',
      'sap_physical_qty',
      'sap_transit_1002',
      'sap_qty_1004',
      'sap_qty_1007',
      'difference',
      'status',
    ];
  }, [comparisonType, comparisonBase]);

  const exportRows = (subset) => {
    const list = subset || displayRows;
    const objRows = list.map((r) => {
      const o = {};
      for (const h of headersForCsv) o[h] = r[h];
      return o;
    });
    downloadCsvFile(`stock-comparison-${comparisonType}-${Date.now()}.csv`, headersForCsv, objRows);
  };

  const exportMismatch = () => {
    const mis = displayRows.filter((r) => r.status !== 'Match');
    exportRows(mis);
  };

  const printReport = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<html><head><title>Stock comparison</title></head><body>`);
    w.document.write(printRef.current?.innerHTML || '');
    w.document.write('</body></html>');
    w.document.close();
    w.focus();
    w.print();
    w.close();
  };

  const thList = useMemo(() => {
    if (comparisonType === 'main_vs_rack') {
      return [
        ['part_number', 'Part #'],
        ['sap_part_number', 'SAP Part #'],
        ['description', 'Description'],
        ['main_stock_available_qty', 'Main avail'],
        ['stock_by_rack_available_qty', 'Rack avail'],
        ['sap_qty', 'SAP qty'],
        ['difference', 'Diff'],
        ['status', 'Status'],
      ];
    }
    if (comparisonBase === 'sap_stock') {
      return [
        ['sap_material', 'SAP material'],
        ['description', 'Description'],
        ['sap_physical_qty', 'SAP physical'],
        ['main_stock_qty', 'Main qty'],
        ['difference', 'Diff'],
        ['status', 'Status'],
      ];
    }
    return [
      ['part_number', 'Part #'],
      ['sap_part_number', 'SAP Part #'],
      ['description', 'Description'],
      ['main_stock_available_qty', 'Main avail'],
      ['sap_physical_qty', 'SAP physical'],
      ['sap_transit_1002', 'Transit 1002'],
      ['sap_qty_1004', '1004'],
      ['sap_qty_1007', '1007'],
      ['difference', 'Diff'],
      ['status', 'Status'],
    ];
  }, [comparisonType, comparisonBase]);

  return (
    <div className="max-w-[1920px] mx-auto px-2 sm:px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h1 className="text-sm font-black text-gray-900 tracking-tight flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-primary-600" />
          Stock Comparison Report
        </h1>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={exportMismatch}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-[11px] font-bold text-amber-900 hover:bg-amber-100"
          >
            <Download className="w-3.5 h-3.5" />
            Export mismatch CSV
          </button>
          <button
            type="button"
            onClick={() => exportRows()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export full CSV
          </button>
          <button
            type="button"
            onClick={printReport}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-2 items-end">
        <label className="flex flex-col text-[10px] font-bold text-gray-500">
          Comparison type
          <select
            value={comparisonType}
            onChange={(e) => setComparisonType(e.target.value)}
            className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold bg-white min-w-[180px]"
          >
            <option value="main_vs_sap">Main Stock vs SAP Stock</option>
            <option value="main_vs_rack">Main Stock vs Stock By Rack</option>
          </select>
        </label>
        {comparisonType === 'main_vs_sap' ? (
          <label className="flex flex-col text-[10px] font-bold text-gray-500">
            Comparison base
            <select
              value={comparisonBase}
              onChange={(e) => setComparisonBase(e.target.value)}
              className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold bg-white min-w-[140px]"
            >
              <option value="main_stock">Main Stock</option>
              <option value="sap_stock">SAP Stock</option>
            </select>
          </label>
        ) : null}
        <label className="flex flex-col text-[10px] font-bold text-gray-500">
          Storage location (SAP)
          <select
            value={storageLocation}
            onChange={(e) => setStorageLocation(e.target.value)}
            className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold bg-white min-w-[160px]"
          >
            <option value="1004_1007">1004 + 1007 (default physical)</option>
            <option value="1002">1002 Transit</option>
            <option value="1004">1004 Physical</option>
            <option value="1007">1007 Physical</option>
            <option value="all">All (1002+1004+1007)</option>
          </select>
        </label>
        <label className="flex flex-col text-[10px] font-bold text-gray-500">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold bg-white min-w-[160px]"
          >
            <option value="all">All</option>
            <option value="match_only">Match only</option>
            <option value="mismatch_only">Mismatch only</option>
            <option value="missing_in_sap">Missing in SAP</option>
            <option value="extra_in_sap">Extra in SAP</option>
            <option value="difference_gt_0">Difference &gt; 0</option>
            <option value="difference_lt_0">Difference &lt; 0</option>
            <option value="difference_eq_0">Difference = 0</option>
          </select>
        </label>
        <label className="flex flex-col text-[10px] font-bold text-gray-500 flex-1 min-w-[140px]">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Part, SAP, description, vendor, material group…"
            className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] w-full max-w-md"
          />
        </label>
        <label className="flex flex-col text-[10px] font-bold text-gray-500">
          Date from
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px]"
          />
        </label>
        <label className="flex flex-col text-[10px] font-bold text-gray-500">
          Date to
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px]"
          />
        </label>
      </div>

      {meta?.batch_id != null && meta.batch_id !== undefined ? (
        <p className="text-[10px] text-gray-500 mb-1">SAP batch #{meta.batch_id}</p>
      ) : null}
      {err ? <div className="text-[11px] font-bold text-red-700 mb-2">{err}</div> : null}

      <div ref={printRef} className="border border-gray-200 rounded-lg overflow-auto bg-white">
        <table className="min-w-full text-[11px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {thList.map(([k, label]) => (
                <SortTh key={k} label={label} k={k} sortKey={sortKey} direction={direction} onSort={requestSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length ? (
              <tr>
                <td colSpan={12} className="p-4 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : null}
            {!loading && !displayRows.length ? (
              <tr>
                <td colSpan={12} className="p-4 text-center text-gray-500">
                  No rows
                </td>
              </tr>
            ) : null}
            {displayRows.map((r, i) => (
              <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                {thList.map(([k]) => {
                  const numish =
                    String(k).includes('qty') || k === 'difference' || k === 'sap_qty' || k === 'sap_physical_qty';
                  const v = numish ? fmt(r[k]) || '—' : r[k] ?? '—';
                  return (
                    <td key={k} className={`px-2 py-1 whitespace-nowrap ${numish ? 'text-right font-mono' : ''}`}>
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
