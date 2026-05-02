import { useEffect, useMemo, useRef, useState } from 'react';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import * as XLSX from 'xlsx';
import api from '../services/api';
import { Download, Printer, FileSpreadsheet } from 'lucide-react';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Generic report: fetch JSON rows from /api/reports/* and export Excel / CSV / print */
export default function ReportExportPage({ title, fileSlug, endpoint, hint }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const printRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const { data } = await api.get(endpoint, { params: { limit: 8000 } });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const columns = useMemo(() => {
    if (!rows.length) return [];
    return Object.keys(rows[0]);
  }, [rows]);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows);

  const exportXlsx = () => {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, `${fileSlug}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const exportCsv = () => {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `${fileSlug}-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const printReport = () => {
    window.print();
  };

  return (
    <div className="max-w-[1600px]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
          {hint ? <p className="text-[11px] text-gray-600 mt-0.5">{hint}</p> : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={load} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportXlsx} disabled={!rows.length}>
            <FileSpreadsheet size={14} /> Export Excel
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportCsv} disabled={!rows.length}>
            <Download size={14} /> Export CSV
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={printReport} disabled={!rows.length}>
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      {err ? <div className="mb-2 text-[11px] text-red-700">{err}</div> : null}
      {loading ? <div className="text-[11px] text-gray-500 py-6">Loading…</div> : null}

      <div ref={printRef} className="bg-white border rounded-lg overflow-x-auto print:shadow-none">
        <table className="min-w-full text-[10px] border-collapse">
          <thead>
            <tr className="bg-gray-50 border-b">
              {columns.map((c) => (
                <SortTh
                  key={c}
                  bare
                  columnKey={c}
                  sortKey={sortKey}
                  direction={direction}
                  onSort={requestSort}
                  className="text-left px-2 py-1.5 font-bold text-gray-700 whitespace-nowrap border-r border-gray-100"
                >
                  {c}
                </SortTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, i) => (
              <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                {columns.map((c) => (
                  <td key={c} className="px-2 py-1 whitespace-nowrap border-r border-gray-50 max-w-[240px] truncate" title={String(r[c] ?? '')}>
                    {r[c] === null || r[c] === undefined ? '' : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length ? <div className="p-6 text-[11px] text-gray-500">No rows.</div> : null}
      </div>
    </div>
  );
}
