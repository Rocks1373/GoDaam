import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare, Printer, Download, FileDown } from 'lucide-react';
import { reportsApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import {
  COL_TOOLTIPS,
  DEFAULT_COL_WIDTHS,
  WIDTH_STORAGE_KEY,
  UNIFIED_GROUP_HEADER,
} from './stockComparisonColumnMeta';
import { exportJsonToExcel } from '../utils/exportExcel';

const SAP_STORAGE_CODES = ['1001', '1002', '1003', '1004', '1005', '1007'];

/** Simple compare: result = main − picked; difference = result − SAP stock; match when difference = 0. */
const SIMPLE_COMPARE_COLS = [
  ['part_number', 'Part #'],
  ['sap_part_number', 'SAP Part #'],
  ['description', 'Description'],
  ['main_stock_available_qty', 'Main stock total'],
  ['picked_not_delivered_qty', 'Picked not delivered'],
  ['compare_result_qty', 'Result'],
  ['sap_physical_qty', 'SAP stock'],
  ['difference', 'Difference'],
  ['comparison_result', 'Match'],
];

const SIMPLE_UNIFIED_COLS = [
  ...SIMPLE_COMPARE_COLS.slice(0, -1),
  ['stock_by_rack_available_qty', 'Rack sum'],
  ['main_vs_rack_difference', 'Main − rack'],
  ['comparison_result', 'Match'],
];

const SIMPLE_EXPORT_KEYS = [
  'part_number',
  'sap_part_number',
  'description',
  'main_stock_available_qty',
  'picked_not_delivered_qty',
  'compare_result_qty',
  'sap_physical_qty',
  'difference',
  'comparison_result',
];

const FILTER_SESSION_KEY = 'godam_stock_comparison_filters_v5';

function readFilterSession() {
  try {
    const raw = sessionStorage.getItem(FILTER_SESSION_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return typeof j === 'object' && j !== null ? j : {};
  } catch {
    return {};
  }
}

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

function isNumishKey(k) {
  return (
    String(k).includes('qty') ||
    k === 'difference' ||
    k === 'sap_qty' ||
    k === 'sap_physical_qty' ||
    k === 'main_vs_sap_difference' ||
    k === 'main_vs_rack_difference' ||
    k === 'sap_qty_on_main' ||
    k === 'main_stock_qty' ||
    k === 'picked_not_delivered_qty' ||
    k === 'main_stock_compare_qty' ||
    k === 'adjusted_main_qty' ||
    k === 'compare_result_qty' ||
    k === 'stock_upload_qty'
  );
}

function readWidthStore() {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return typeof j === 'object' && j !== null ? j : {};
  } catch {
    return {};
  }
}

function writeWidthStore(store) {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

function ReportTh({
  columnKey,
  label,
  title,
  widthPx,
  onResizeStart,
  sortKey,
  direction,
  onSort,
}) {
  const active = sortKey === columnKey;
  return (
    <th
      scope="col"
      role="columnheader"
      title={title || undefined}
      aria-label={title ? `${label}. ${title}` : label}
      style={{
        width: widthPx,
        minWidth: widthPx,
        maxWidth: widthPx,
        position: 'relative',
        verticalAlign: 'bottom',
      }}
      className="border-r border-gray-200 bg-gray-50 px-1.5 py-1.5 text-left text-[10px] font-bold text-gray-800"
    >
      <button
        type="button"
        className="flex w-full items-start gap-1 text-left cursor-pointer select-none hover:bg-gray-100 rounded px-0.5 -mx-0.5"
        onClick={() => onSort(columnKey)}
        aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <span className="min-w-0 flex-1 leading-snug break-words whitespace-normal">{label}</span>
        <span className="text-[9px] tabular-nums opacity-60 shrink-0 pt-0.5" aria-hidden>
          {active ? (direction === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </button>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize column ${label}`}
        title="Drag left or right to resize this column"
        className="absolute right-0 top-0 bottom-0 z-10 w-2 cursor-col-resize hover:bg-blue-500/25 active:bg-blue-500/40 border-r border-transparent hover:border-blue-400/40"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onResizeStart(columnKey, e.clientX);
        }}
      />
    </th>
  );
}

export default function StockComparisonReport() {
  const [boot] = useState(() => readFilterSession());
  const [comparisonType, setComparisonType] = useState(() => boot.comparisonType ?? 'main_unified');
  const [comparisonBase, setComparisonBase] = useState(() => boot.comparisonBase ?? 'main_stock');

  useEffect(() => {
    if (comparisonType === 'main_vs_rack' || comparisonType === 'main_unified') setComparisonBase('main_stock');
  }, [comparisonType]);

  const [selectedStorageLocs, setSelectedStorageLocs] = useState(() => {
    const locs = Array.isArray(boot.storageLocs) ? boot.storageLocs : null;
    if (locs && locs.length) {
      const ok = [...new Set(locs.map(String).filter((c) => SAP_STORAGE_CODES.includes(c)))];
      if (ok.length) return ok.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
    return ['1004', '1007'];
  });
  const [vendorKeys, setVendorKeys] = useState(() => {
    if (Array.isArray(boot.vendorKeys) && boot.vendorKeys.length) {
      return [...new Set(boot.vendorKeys.map(String))];
    }
    if (typeof boot.vendorNumber === 'string' && boot.vendorNumber.trim()) return [boot.vendorNumber.trim()];
    return [];
  });
  const [status, setStatus] = useState(() => boot.status ?? 'all');
  const [search, setSearch] = useState(() => boot.search ?? '');
  const [dateFrom, setDateFrom] = useState(() => boot.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(() => boot.dateTo ?? '');
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const printRef = useRef(null);

  const vendorKeysSig = useMemo(() => [...vendorKeys].sort().join('|'), [vendorKeys]);
  const storageLocsSig = useMemo(
    () => [...selectedStorageLocs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('+'),
    [selectedStorageLocs]
  );

  const layoutKey = useMemo(() => {
    if (comparisonType === 'main_vs_sap') return `main_vs_sap|sl:${storageLocsSig}|v:${vendorKeysSig}|v7-adj`;
    return `${comparisonType}|sl:${storageLocsSig}|v:${vendorKeysSig}|v7-adj`;
  }, [comparisonType, comparisonBase, storageLocsSig, vendorKeysSig]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        FILTER_SESSION_KEY,
        JSON.stringify({
          comparisonType,
          comparisonBase,
          storageLocs: selectedStorageLocs,
          vendorKeys,
          status,
          search,
          dateFrom,
          dateTo,
        })
      );
    } catch {
      // ignore
    }
  }, [comparisonType, comparisonBase, selectedStorageLocs, vendorKeys, status, search, dateFrom, dateTo]);

  const [colWidths, setColWidths] = useState(() => ({}));
  const colWidthsRef = useRef({});
  const resizeRef = useRef(null);

  useEffect(() => {
    colWidthsRef.current = colWidths;
  }, [colWidths]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      if (comparisonType !== 'main_vs_rack' && selectedStorageLocs.length === 0) {
        setRows([]);
        setMeta(null);
        setErr('Select at least one SAP storage location (e.g. 1004).');
        return;
      }
      const base = comparisonType === 'main_vs_rack' ? 'main_stock' : 'main_stock';
      const storage_locs =
        comparisonType === 'main_vs_rack'
          ? undefined
          : [...selectedStorageLocs]
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
              .join(',');
      const data = await reportsApi.stockComparison({
        comparison_type: comparisonType,
        comparison_base: base,
        ...(storage_locs ? { storage_locs } : {}),
        status,
        search: search.trim(),
        ...(vendorKeys.length ? { vendor_numbers: vendorKeys.join(',') } : {}),
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
  }, [comparisonType, comparisonBase, selectedStorageLocs, status, search, dateFrom, dateTo, vendorKeys]);

  useEffect(() => {
    const t = setTimeout(() => load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  const sortValue = useCallback((r, k) => {
    if (isNumishKey(k)) return Number(r[k]) || 0;
    return r[k];
  }, []);
  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, sortValue);

  const thList = useMemo(() => {
    if (comparisonType === 'main_unified') return SIMPLE_UNIFIED_COLS;
    if (comparisonType === 'main_vs_sap') return SIMPLE_COMPARE_COLS;
    if (comparisonType === 'main_vs_rack') {
      return [
        ['part_number', 'Part #'],
        ['sap_part_number', 'SAP Part #'],
        ['description', 'Description'],
        ['vendor_number', 'Vendor #'],
        ['vendor_name', 'Vendor name'],
        ['main_stock_available_qty', 'Main avail'],
        ['stock_by_rack_available_qty', 'Rack avail'],
        ['sap_qty', 'SAP qty'],
        ['difference', 'Diff'],
        ['rack_balance', 'Rack vs main'],
        ['comparison_result', 'Match'],
      ];
    }
    return SIMPLE_COMPARE_COLS;
  }, [comparisonType, comparisonBase]);

  const tablePixelWidth = useMemo(
    () => thList.reduce((sum, [k]) => sum + (colWidths[k] ?? DEFAULT_COL_WIDTHS[k] ?? 96), 0),
    [thList, colWidths]
  );

  useEffect(() => {
    const store = readWidthStore();
    const saved = store[layoutKey] || {};
    const next = {};
    for (const [k] of thList) {
      const d = DEFAULT_COL_WIDTHS[k] ?? 96;
      next[k] = typeof saved[k] === 'number' && saved[k] >= 48 ? saved[k] : d;
    }
    setColWidths(next);
  }, [layoutKey, thList]);

  const persistWidths = useCallback((nextMap) => {
    const store = readWidthStore();
    store[layoutKey] = nextMap;
    writeWidthStore(store);
  }, [layoutKey]);

  useEffect(() => {
    const onMove = (e) => {
      const r = resizeRef.current;
      if (!r) return;
      const dx = e.clientX - r.startX;
      const raw = r.startW + dx;
      const w = Math.min(640, Math.max(48, raw));
      setColWidths((prev) => {
        const next = { ...prev, [r.key]: w };
        colWidthsRef.current = next;
        return next;
      });
    };
    const onUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      persistWidths({ ...colWidthsRef.current });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [persistWidths]);

  const beginResize = useCallback((columnKey, clientX) => {
    setColWidths((prev) => {
      const startW = prev[columnKey] ?? DEFAULT_COL_WIDTHS[columnKey] ?? 96;
      resizeRef.current = { key: columnKey, startX: clientX, startW };
      return prev;
    });
  }, []);

  const headersForCsv = useMemo(() => {
    if (comparisonType === 'main_unified') {
      return [...SIMPLE_EXPORT_KEYS, 'stock_by_rack_available_qty', 'main_vs_rack_difference'];
    }
    if (comparisonType === 'main_vs_sap') return SIMPLE_EXPORT_KEYS;
    if (comparisonType === 'main_vs_rack') {
      return [
        'part_number',
        'sap_part_number',
        'description',
        'vendor_number',
        'vendor_name',
        'main_stock_available_qty',
        'stock_by_rack_available_qty',
        'sap_qty',
        'difference',
        'rack_balance',
        'comparison_result',
      ];
    }
    return SIMPLE_EXPORT_KEYS;
  }, [comparisonType, comparisonBase]);

  const mismatchExportKeys = useMemo(() => {
    if (comparisonType === 'main_unified' || comparisonType === 'main_vs_sap') {
      return SIMPLE_EXPORT_KEYS;
    }
    if (comparisonType === 'main_vs_rack') {
      return [
        'part_number',
        'sap_part_number',
        'comparison_result',
        'rack_balance',
        'main_stock_available_qty',
        'stock_by_rack_available_qty',
        'difference',
      ];
    }
    return SIMPLE_EXPORT_KEYS;
  }, [comparisonType, comparisonBase]);

  const buildExportObjects = (subset, keysOverride) => {
    const list = subset || displayRows;
    const keys = keysOverride || headersForCsv;
    return list.map((r) => {
      const o = {};
      for (const h of keys) o[h] = r[h];
      return o;
    });
  };

  const exportRowsCsv = (subset, keysOverride) => {
    const keys = keysOverride || headersForCsv;
    const objRows = buildExportObjects(subset, keysOverride);
    downloadCsvFile(
      `stock-comparison-${comparisonType}${vendorKeys.length ? `-${vendorKeysSig.replace(/[^\w.-]+/g, '_')}` : ''}-${Date.now()}.csv`,
      keys,
      objRows
    );
  };

  const exportRowsExcel = (subset, keysOverride) => {
    const slug = `stock-comparison-${comparisonType}${vendorKeys.length ? `-${vendorKeysSig.replace(/[^\w.-]+/g, '_')}` : ''}-${Date.now()}.xlsx`;
    exportJsonToExcel(buildExportObjects(subset, keysOverride), slug, 'Stock Comparison');
  };

  const exportMismatch = () => {
    const mis = displayRows.filter((r) => (r.comparison_result ?? r.status) === 'Mismatching');
    exportRowsCsv(mis, mismatchExportKeys);
  };

  const exportMismatchExcel = () => {
    const mis = displayRows.filter((r) => (r.comparison_result ?? r.status) === 'Mismatching');
    exportRowsExcel(mis, mismatchExportKeys);
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

  const toggleStorageLoc = useCallback((code) => {
    setSelectedStorageLocs((prev) => {
      if (prev.includes(code)) {
        const next = prev.filter((c) => c !== code);
        return next.length ? next : prev;
      }
      return [...prev, code].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    });
  }, []);

  const applyStoragePreset = useCallback((kind) => {
    if (kind === 'physical') setSelectedStorageLocs(['1004', '1007']);
    else if (kind === 'all') setSelectedStorageLocs([...SAP_STORAGE_CODES]);
    else if (kind === 'legacy') setSelectedStorageLocs(['1002', '1004', '1007']);
  }, []);

  const toggleVendorKey = useCallback((scopeKey) => {
    setVendorKeys((prev) => {
      if (prev.includes(scopeKey)) return prev.filter((k) => k !== scopeKey);
      return [...prev, scopeKey].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    });
  }, []);

  const colSpan = thList.length;
  const showUnifiedGroups = comparisonType === 'main_unified';

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
            onClick={exportMismatchExcel}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-300 bg-amber-50 text-[11px] font-bold text-amber-900 hover:bg-amber-100"
          >
            <FileDown className="w-3.5 h-3.5" />
            Export mismatch Excel
          </button>
          <button
            type="button"
            onClick={() => exportRowsExcel()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-primary-300 bg-primary-50 text-[11px] font-bold text-primary-900 hover:bg-primary-100"
          >
            <FileDown className="w-3.5 h-3.5" />
            Export full Excel
          </button>
          <button
            type="button"
            onClick={exportMismatch}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-700 hover:bg-gray-50"
          >
            <Download className="w-3.5 h-3.5" />
            Mismatch CSV
          </button>
          <button
            type="button"
            onClick={() => exportRowsCsv()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-300 bg-white text-[11px] font-bold text-gray-800 hover:bg-gray-50"
          >
            <Download className="w-3.5 h-3.5" />
            Full CSV
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

      <div className="rounded-lg border border-gray-200 bg-gray-50/80 p-2.5 mb-2 space-y-2.5">
        <div className="text-[10px] font-extrabold uppercase tracking-wide text-gray-500">Comparison filters</div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 items-start">
          <div className="min-w-[200px]">
            <div className="text-[10px] font-bold text-gray-500 mb-1">Comparison base</div>
            {comparisonType === 'main_vs_sap' ? (
              <div
                className="inline-flex rounded-md border border-gray-300 bg-white p-0.5 shadow-sm"
                role="group"
                aria-label="Comparison base"
              >
                <button
                  type="button"
                  onClick={() => setComparisonBase('main_stock')}
                  className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                    comparisonBase === 'main_stock'
                      ? 'bg-primary-600 text-white'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  Main stock
                </button>
                <button
                  type="button"
                  onClick={() => setComparisonBase('sap_stock')}
                  className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
                    comparisonBase === 'sap_stock'
                      ? 'bg-primary-600 text-white'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  SAP
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-gray-600 leading-snug">
                Rows follow <span className="font-bold">main stock</span>.
              </p>
            )}
          </div>

          <div className="min-w-[220px] max-w-[min(100%,360px)] flex-1">
            <div className="text-[10px] font-bold text-gray-500 mb-1">Vendors (multi-select)</div>
            <div className="max-h-[120px] overflow-y-auto rounded border border-gray-200 bg-white px-2 py-1.5 space-y-1">
              {(meta?.available_vendors || []).length === 0 ? (
                <span className="text-[10px] text-gray-400">Load report to list vendors…</span>
              ) : (
                (meta?.available_vendors || []).map((v) => {
                  const scope = v.vendor_scope_key ?? v.vendor_number;
                  const disp = v.vendor_number_display ?? v.vendor_number;
                  const label =
                    v.vendor_name != null && String(v.vendor_name).trim()
                      ? `${scope} — ${String(v.vendor_name).trim()}`
                      : disp !== scope
                        ? `${scope} (${disp})`
                        : scope;
                  const checked = vendorKeys.includes(scope);
                  return (
                    <label key={scope} className="flex items-start gap-1.5 cursor-pointer text-[11px] leading-tight">
                      <input
                        type="checkbox"
                        className="mt-0.5 rounded border-gray-300"
                        checked={checked}
                        onChange={() => toggleVendorKey(scope)}
                      />
                      <span>{label}</span>
                    </label>
                  );
                })
              )}
            </div>
            <p className="text-[9px] text-gray-500 mt-0.5">None selected = all vendors</p>
          </div>

          <div className="min-w-[240px] flex-1 max-w-lg">
            <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
              <span className="text-[10px] font-bold text-gray-500">SAP storage locations</span>
              <span className="flex flex-wrap gap-0.5">
                <button
                  type="button"
                  disabled={comparisonType === 'main_vs_rack'}
                  onClick={() => applyStoragePreset('physical')}
                  className="text-[9px] font-bold px-1 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  1004+1007
                </button>
                <button
                  type="button"
                  disabled={comparisonType === 'main_vs_rack'}
                  onClick={() => applyStoragePreset('all')}
                  className="text-[9px] font-bold px-1 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  All SL
                </button>
                <button
                  type="button"
                  disabled={comparisonType === 'main_vs_rack'}
                  onClick={() => applyStoragePreset('legacy')}
                  className="text-[9px] font-bold px-1 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40"
                >
                  Legacy
                </button>
              </span>
            </div>
            <div
              className={`flex flex-wrap gap-x-2 gap-y-1 rounded border px-2 py-1.5 bg-white ${
                comparisonType === 'main_vs_rack' ? 'border-gray-200 opacity-50 pointer-events-none' : 'border-gray-200'
              }`}
              title={comparisonType === 'main_vs_rack' ? 'SAP locations apply when the report includes SAP' : undefined}
            >
              {SAP_STORAGE_CODES.map((code) => {
                const labels = {
                  1001: '1001',
                  1002: '1002 transit',
                  1003: '1003',
                  1004: '1004 phys',
                  1005: '1005',
                  1007: '1007 phys',
                };
                return (
                  <label key={code} className="inline-flex items-center gap-1 text-[11px] font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300"
                      checked={selectedStorageLocs.includes(code)}
                      disabled={comparisonType === 'main_vs_rack'}
                      onChange={() => toggleStorageLoc(code)}
                    />
                    <span>{labels[code] || code}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-[9px] text-gray-500 mt-0.5">
              <strong>SAP stock</strong> column = sum of ticked SL only (e.g. tick 1004 + 1007 → both added).
            </p>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-2 flex flex-wrap gap-2 items-end">
          <label className="flex flex-col text-[10px] font-bold text-gray-500">
            Report mode
            <select
              value={comparisonType}
              onChange={(e) => setComparisonType(e.target.value)}
              className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold bg-white min-w-[280px]"
            >
              <option value="main_unified">Main stock vs SAP + rack (combined)</option>
              <option value="main_vs_sap">Main stock vs SAP only</option>
              <option value="main_vs_rack">Main stock vs rack only</option>
            </select>
          </label>
          <label className="flex flex-col text-[10px] font-bold text-gray-500">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-0.5 border border-gray-300 rounded px-1.5 py-1 text-[11px] font-bold bg-white min-w-[180px]"
            >
              <option value="all">All</option>
              <option value="match_only">Matching only</option>
              <option value="mismatch_only">Mismatching only</option>
              <option value="mismatch_sap_only">SAP not OK (Excess/Less)</option>
              <option value="mismatch_rack_only">Rack not OK (Excess/Less)</option>
              <option value="sap_excess">SAP side: main excess</option>
              <option value="sap_less">SAP side: main less</option>
              <option value="rack_excess">Rack side: main excess</option>
              <option value="rack_less">Rack side: main less</option>
              <option value="missing_in_sap">Missing in SAP</option>
              <option value="extra_in_sap">Extra in SAP</option>
              <option value="difference_gt_0">Any diff &gt; 0 (main higher)</option>
              <option value="difference_lt_0">Any diff &lt; 0 (main lower)</option>
              <option value="difference_eq_0">Both diffs = 0</option>
            </select>
          </label>
          <label className="flex flex-col text-[10px] font-bold text-gray-500 flex-1 min-w-[140px]">
            Search
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Part, SAP, SAP material, description, vendor…"
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
      </div>

      {meta?.vendor_filter ? (
        <p className="text-[10px] text-gray-600 mb-1">
          Filtered to vendor key{String(meta.vendor_filter).includes(',') ? 's' : ''}{' '}
          <span className="font-mono font-bold">
            {(Array.isArray(meta.vendor_filters) && meta.vendor_filters.length
              ? meta.vendor_filters
              : String(meta.vendor_filter || '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            ).join(', ')}
          </span>
          {meta.vendor_filter_display && meta.vendor_filter_display !== meta.vendor_filter ? (
            <>
              {' '}
              (selection: <span className="font-mono">{meta.vendor_filter_display}</span>)
            </>
          ) : null}
          {' — '}
          SAP rows limited to matching material_group / vendor keys or materials tied to filtered main rows.
        </p>
      ) : null}
      {comparisonType !== 'main_vs_rack' ? (
        meta?.batch_id != null ? (
          <p className="text-[10px] text-gray-500 mb-1">SAP batch #{meta.batch_id}</p>
        ) : (
          <p className="text-[10px] text-amber-700 mb-1">
            No processed SAP batch in date range — SAP-related columns will be zero until a batch is processed.
          </p>
        )
      ) : null}
      {err ? <div className="text-[11px] font-bold text-red-700 mb-2">{err}</div> : null}

      <div ref={printRef} className="border border-gray-200 rounded-lg overflow-auto bg-white max-h-[min(78vh,920px)] shadow-sm">
        <table
          className="text-[11px] border-collapse table-fixed"
          style={{ width: Math.max(tablePixelWidth, 400) }}
        >
          <thead className="border-b border-gray-200">
            {showUnifiedGroups ? (
              <tr className="bg-slate-100">
                {UNIFIED_GROUP_HEADER.map((g, gi) => (
                  <th
                    key={gi}
                    colSpan={g.colSpan}
                    scope="colgroup"
                    className="border-r border-slate-200 px-2 py-1 text-center text-[10px] font-extrabold uppercase tracking-wide text-slate-700"
                  >
                    {g.title}
                  </th>
                ))}
              </tr>
            ) : null}
            <tr className="bg-gray-50">
              {thList.map(([k, label]) => (
                <ReportTh
                  key={k}
                  columnKey={k}
                  label={label}
                  title={COL_TOOLTIPS[k]}
                  widthPx={colWidths[k] ?? DEFAULT_COL_WIDTHS[k] ?? 96}
                  onResizeStart={beginResize}
                  sortKey={sortKey}
                  direction={direction}
                  onSort={requestSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length ? (
              <tr>
                <td colSpan={colSpan} className="p-4 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : null}
            {!loading && !displayRows.length ? (
              <tr>
                <td colSpan={colSpan} className="p-4 text-center text-gray-500">
                  No rows
                </td>
              </tr>
            ) : null}
            {displayRows.map((r, i) => (
              <tr
                key={i}
                className={`border-b border-gray-100 hover:bg-gray-50 ${
                  (r.comparison_result ?? r.status) === 'Mismatching' ? 'bg-amber-50/60' : ''
                }`}
              >
                {thList.map(([k]) => {
                  const numish = isNumishKey(k);
                  const v = numish ? fmt(r[k]) || '—' : r[k] ?? '—';
                  const w = colWidths[k] ?? DEFAULT_COL_WIDTHS[k] ?? 96;
                  const wrap =
                    k === 'description' ||
                    k === 'comparison_result' ||
                    k === 'sap_balance' ||
                    k === 'rack_balance' ||
                    String(k).includes('status')
                      ? 'whitespace-normal break-words'
                      : 'whitespace-nowrap overflow-hidden text-ellipsis';
                  return (
                    <td
                      key={k}
                      title={typeof v === 'string' && v.length > 20 ? v : undefined}
                      style={{ width: w, minWidth: w, maxWidth: w }}
                      className={`border-r border-gray-100 px-2 py-1 align-top ${wrap} ${
                        numish ? 'text-right font-mono' : ''
                      } ${
                        k === 'main_vs_sap_difference' || k === 'main_vs_rack_difference' || k === 'difference'
                          ? Number(r[k]) > 0
                            ? 'text-emerald-800'
                            : Number(r[k]) < 0
                              ? 'text-red-800'
                              : ''
                          : ''
                      } ${
                        k === 'comparison_result' && v === 'Mismatching' ? 'font-bold text-amber-900' : ''
                      }`}
                    >
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
