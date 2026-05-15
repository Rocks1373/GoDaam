import { useCallback, useMemo, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import { reportsApi } from '../services/api';
import api from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function shortJson(s, max = 120) {
  if (s == null || s === '') return '';
  const t = String(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const COLS = [
  { key: 'created_at', label: 'Time' },
  { key: 'warehouse_code', label: 'WH' },
  { key: 'user_name', label: 'User' },
  { key: 'user_role', label: 'Role' },
  { key: 'module_name', label: 'Module' },
  { key: 'action_type', label: 'Action' },
  { key: 'reference_type', label: 'Ref type' },
  { key: 'reference_id', label: 'Ref id' },
  { key: 'reference_number', label: 'Ref #' },
  { key: 'status_before', label: 'From' },
  { key: 'status_after', label: 'To' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'new_value_json', label: 'New' },
  { key: 'old_value_json', label: 'Old' },
  { key: 'ip_address', label: 'IP' },
];

export default function AuditLogReport() {
  const printRef = useRef(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const limit = 200;

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [actionType, setActionType] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [search, setSearch] = useState('');

  const makeListParams = useCallback(
    (off) => {
      const p = { limit, offset: off };
      if (dateFrom) p.date_from = dateFrom;
      if (dateTo) p.date_to = dateTo;
      if (moduleName.trim()) p.module_name = moduleName.trim();
      if (actionType.trim()) p.action_type = actionType.trim();
      if (referenceNumber.trim()) p.reference_number = referenceNumber.trim();
      if (search.trim()) p.search = search.trim();
      return p;
    },
    [limit, dateFrom, dateTo, moduleName, actionType, referenceNumber, search]
  );

  const sortValue = useCallback((r, k) => {
    if (k === 'created_at') {
      const t = r.created_at ? new Date(r.created_at).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    if (k === 'reference_id') return Number(r.reference_id) || 0;
    return r[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, sortValue);

  const fetchList = useCallback(
    async (off) => {
      setLoading(true);
      setErr('');
      try {
        const params = makeListParams(off);
        const data = await reportsApi.auditLogs(params);
        setRows(Array.isArray(data?.rows) ? data.rows : []);
        setTotal(Number(data?.total) || 0);
      } catch (e) {
        setErr(e.response?.data?.error || e.message || 'Failed');
        setRows([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [makeListParams]
  );

  const applyFilters = async () => {
    setOffset(0);
    await fetchList(0);
  };

  const goPage = async (delta) => {
    const next = Math.max(0, offset + delta * limit);
    if (next === offset && delta < 0) return;
    if (next >= total && delta > 0) return;
    setOffset(next);
    await fetchList(next);
  };

  const exportParams = useMemo(() => {
    const p = makeListParams(0);
    delete p.offset;
    p.limit = 20000;
    return p;
  }, [makeListParams]);

  const exportCsv = async () => {
    setErr('');
    try {
      const res = await api.get('/reports/audit-logs/export-csv', { params: exportParams, responseType: 'blob' });
      downloadBlob(res.data, `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Export failed');
    }
  };

  const exportXlsx = async () => {
    setErr('');
    try {
      const res = await api.get('/reports/audit-logs/export-excel', { params: exportParams, responseType: 'blob' });
      downloadBlob(res.data, `audit-logs-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Export failed');
    }
  };

  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <div className="max-w-[1680px]">
      <div className="mb-3">
        <h2 className="text-base font-bold text-gray-900">Audit Log Report</h2>
        <p className="text-[11px] text-gray-600 mt-0.5">
          Business events only (outbound, delivery, inbound, putaway, stock, POD). Scoped to your warehouse selection unless you have
          multi-warehouse access.
        </p>
      </div>

      <div className="bg-white border rounded-lg p-3 mb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <label className="text-[10px] font-bold text-gray-700">
          Date from
          <input type="date" className="input-field mt-0.5 w-full" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Date to
          <input type="date" className="input-field mt-0.5 w-full" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Module
          <input
            className="input-field mt-0.5 w-full"
            value={moduleName}
            onChange={(e) => setModuleName(e.target.value)}
            placeholder="e.g. DELIVERY"
          />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Action
          <input
            className="input-field mt-0.5 w-full"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            placeholder="e.g. MARK_DELIVERED"
          />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Reference #
          <input className="input-field mt-0.5 w-full" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700 lg:col-span-2">
          Search
          <input
            className="input-field mt-0.5 w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Matches ref, remarks, user, module, action, JSON text"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3 items-center print:hidden">
        <button type="button" className="btn-primary" onClick={applyFilters} disabled={loading}>
          {loading ? 'Loading…' : 'Apply filters'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => exportCsv()} disabled={loading}>
          <Download size={14} className="inline mr-1" />
          Export CSV
        </button>
        <button type="button" className="btn-secondary" onClick={() => exportXlsx()} disabled={loading}>
          <FileSpreadsheet size={14} className="inline mr-1" />
          Export Excel
        </button>
        <button type="button" className="btn-secondary" onClick={() => window.print()} disabled={!rows.length}>
          <Printer size={14} className="inline mr-1" />
          Print
        </button>
        <span className="text-[10px] text-gray-600 ml-2">
          {total ? `Showing ${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : null}
        </span>
        <button type="button" className="btn-secondary ml-auto" disabled={!canPrev || loading} onClick={() => goPage(-1)}>
          Previous
        </button>
        <button type="button" className="btn-secondary" disabled={!canNext || loading} onClick={() => goPage(1)}>
          Next
        </button>
      </div>

      {err ? <div className="mb-2 text-[11px] text-red-700">{err}</div> : null}

      <div ref={printRef} className="bg-white border rounded-lg overflow-x-auto">
        <table className="min-w-full text-[10px] border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b">
              {COLS.map((c) => (
                <SortTh
                  key={c.key}
                  bare
                  columnKey={c.key}
                  sortKey={sortKey}
                  direction={direction}
                  onSort={requestSort}
                  className="text-left px-2 py-1.5 font-bold text-gray-700 whitespace-nowrap border-r border-gray-100"
                >
                  {c.label}
                </SortTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r) => (
              <tr key={r.id} className="border-b border-gray-100">
                {COLS.map((c) => (
                  <td
                    key={c.key}
                    className="px-2 py-1 align-top border-r border-gray-50 max-w-[200px] break-words whitespace-normal"
                    title={c.key.endsWith('_json') ? String(r[c.key] || '') : undefined}
                  >
                    {c.key.endsWith('_json') ? shortJson(r[c.key], 140) : r[c.key] == null ? '' : String(r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length ? (
          <div className="p-6 text-[11px] text-gray-500">Apply filters to load audit rows.</div>
        ) : null}
      </div>
    </div>
  );
}
