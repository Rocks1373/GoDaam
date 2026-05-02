import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RefreshCw, Trash2 } from 'lucide-react';
import { maintenanceApi } from '../services/api';

const CONFIRM_PHRASE = 'DELETE ALL OUTBOUND DATA';

export default function AdminMaintenance() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [clearBusy, setClearBusy] = useState(false);
  const [browseTable, setBrowseTable] = useState('outbound_orders');
  const [browseLimit, setBrowseLimit] = useState(50);
  const [browseRows, setBrowseRows] = useState(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseErr, setBrowseErr] = useState('');

  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      const s = await maintenanceApi.outboundStats();
      setStats(s);
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const tableOptions = useMemo(() => {
    if (!stats?.counts) return [];
    return Object.keys(stats.counts).sort();
  }, [stats]);

  const clearAll = async () => {
    if (confirmText.trim() !== CONFIRM_PHRASE) {
      alert(`Type exactly: ${CONFIRM_PHRASE}`);
      return;
    }
    if (
      !window.confirm(
        'This removes ALL outbound orders, lines, FIFO lines, picks, picked-order records, and delivery guards for this app DB. Stock by rack / main stock are NOT changed. Continue?'
      )
    ) {
      return;
    }
    try {
      setClearBusy(true);
      await maintenanceApi.clearOutboundDomain(confirmText.trim());
      setConfirmText('');
      await loadStats();
      setBrowseRows(null);
      alert('Outbound domain cleared. Upload / send-for-pick again to test.');
    } catch (e) {
      alert(e.response?.data?.error || e.message || 'Clear failed');
    } finally {
      setClearBusy(false);
    }
  };

  const loadBrowse = async () => {
    try {
      setBrowseLoading(true);
      setBrowseErr('');
      const res = await maintenanceApi.browseTable(browseTable, browseLimit);
      setBrowseRows(res.rows || []);
    } catch (e) {
      setBrowseRows(null);
      setBrowseErr(e.response?.data?.error || e.message);
    } finally {
      setBrowseLoading(false);
    }
  };

  const browseColumns = useMemo(() => {
    if (!browseRows?.length) return [];
    const keys = new Set();
    browseRows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
    return [...keys].sort();
  }, [browseRows]);

  return (
    <div className="max-w-6xl mx-auto px-3 py-4">
      <div className="flex items-center gap-2 mb-4">
        <Database className="w-6 h-6 text-primary-600" />
        <div>
          <h1 className="text-lg font-bold text-gray-900">Admin · Outbound database</h1>
          <p className="text-[11px] text-gray-600">
            Inspect outbound-related SQLite tables and wipe outbound workflow data for a clean retest. Does not open arbitrary SQL (safer for production).
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 mb-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="text-[11px] text-gray-700">
            {loading ? (
              'Loading…'
            ) : stats ? (
              <>
                <span className="font-semibold">Database file:</span>{' '}
                <code className="bg-gray-100 px-1 rounded">{stats.dbFileName}</code>
                <span className="text-gray-500 ml-2 break-all">{stats.dbPathResolved}</span>
              </>
            ) : (
              'No stats'
            )}
          </div>
          <button type="button" className="btn-secondary flex items-center gap-1 text-[11px]" onClick={loadStats}>
            <RefreshCw size={14} />
            Refresh counts
          </button>
        </div>
        {stats?.counts && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Object.entries(stats.counts).map(([k, v]) => (
              <div key={k} className="border border-gray-100 rounded-md px-2 py-1.5 bg-gray-50">
                <div className="text-[10px] font-bold text-gray-600 truncate" title={k}>
                  {k}
                </div>
                <div className="text-sm font-mono font-bold text-gray-900">{v}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-4">
        <h2 className="text-sm font-bold text-amber-900 mb-2 flex items-center gap-2">
          <Trash2 size={16} />
          Clear all outbound data
        </h2>
        <p className="text-[11px] text-amber-900 mb-3">
          Deletes rows from: outbound_orders, outbound_items, fifo_suggestions, picked_transactions, picked_orders,
          pick_change_requests, pick_suggestions, delivered_outbounds. Users, stock, customers, notifications stay.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
          <label className="flex-1 text-[11px] font-semibold text-gray-800">
            Type confirmation phrase
            <input
              className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1.5 text-[11px] font-mono"
              placeholder={CONFIRM_PHRASE}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="btn bg-red-600 hover:bg-red-700 text-white border-red-700 disabled:opacity-50"
            disabled={clearBusy}
            onClick={clearAll}
          >
            {clearBusy ? 'Working…' : 'Clear outbound domain'}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-bold text-gray-900 mb-2">Browse tables (read-only)</h2>
        <p className="text-[11px] text-gray-600 mb-3">Whitelist only — outbound workflow tables.</p>
        <div className="flex flex-wrap gap-2 items-end mb-3">
          <label className="text-[11px] font-semibold">
            Table
            <select
              className="mt-1 block border border-gray-300 rounded-md px-2 py-1.5 text-[11px]"
              value={browseTable}
              onChange={(e) => setBrowseTable(e.target.value)}
            >
              {(tableOptions.length ? tableOptions : ['outbound_orders']).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] font-semibold">
            Limit
            <input
              type="number"
              min={1}
              max={500}
              className="mt-1 block w-24 border border-gray-300 rounded-md px-2 py-1.5 text-[11px]"
              value={browseLimit}
              onChange={(e) => setBrowseLimit(Number(e.target.value) || 50)}
            />
          </label>
          <button type="button" className="btn-secondary text-[11px]" disabled={browseLoading} onClick={loadBrowse}>
            {browseLoading ? 'Loading…' : 'Load rows'}
          </button>
        </div>
        {browseErr ? <div className="text-[11px] text-red-700 mb-2">{browseErr}</div> : null}
        {browseRows?.length ? (
          <div className="overflow-auto max-h-[420px] border border-gray-200 rounded-md">
            <table className="min-w-full text-[10px]">
              <thead className="bg-gray-100 sticky top-0">
                <tr>
                  {browseColumns.map((c) => (
                    <th key={c} className="text-left px-2 py-1 font-bold border-b border-gray-200 whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {browseRows.map((row, i) => (
                  <tr key={i} className="odd:bg-white even:bg-gray-50">
                    {browseColumns.map((c) => (
                      <td key={c} className="px-2 py-1 border-b border-gray-100 align-top max-w-[200px] truncate" title={String(row[c])}>
                        {row[c] === null || row[c] === undefined ? '' : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : browseRows && !browseRows.length ? (
          <p className="text-[11px] text-gray-500">No rows.</p>
        ) : null}
      </div>
    </div>
  );
}
