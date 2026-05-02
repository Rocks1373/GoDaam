import { useMemo, useRef, useState } from 'react';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import * as XLSX from 'xlsx';
import { reportsApi } from '../services/api';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';

const TRANSPORT_OPTS = ['', 'GAPP', 'Rental', 'Courier', 'Self Collection'];

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DeliveryReport() {
  const [level, setLevel] = useState('header');
  const [filters, setFilters] = useState({
    date_from: '',
    date_to: '',
    outbound_number: '',
    gapp_po: '',
    customer_reference: '',
    invoice_number: '',
    customer_name: '',
    sold_to: '',
    transportation_type: '',
    carrier_name: '',
    driver_name: '',
    truck_type: '',
    status: '',
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const printRef = useRef(null);

  const params = useMemo(() => {
    const p = { level };
    const map = {
      date_from: 'date_from',
      date_to: 'date_to',
      outbound_number: 'outbound_number',
      gapp_po: 'gapp_po',
      customer_reference: 'customer_reference',
      invoice_number: 'invoice_number',
      customer_name: 'customer_name',
      sold_to: 'sold_to',
      transportation_type: 'transportation_type',
      carrier_name: 'carrier_name',
      driver_name: 'driver_name',
      truck_type: 'truck_type',
      status: 'status',
    };
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== '' && v != null) {
        const key = map[k] || k;
        p[key] = v;
      }
    });
    return p;
  }, [level, filters]);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await reportsApi.delivery(params);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const columns = useMemo(() => {
    if (!rows.length) return [];
    return Object.keys(rows[0]);
  }, [rows]);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows);

  const exportXlsx = () => {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, level === 'header' ? 'Header' : 'Items');
    XLSX.writeFile(wb, `delivery-report-${level}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const exportCsv = () => {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, `delivery-report-${level}-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const setF = (key, v) => setFilters((s) => ({ ...s, [key]: v }));

  return (
    <div className="max-w-[1680px]">
      <div className="mb-3">
        <h2 className="text-base font-bold text-gray-900">Delivery Report</h2>
        <p className="text-[11px] text-gray-600 mt-0.5">
          Header level: one row per delivery note. Item level: one row per line item / part number. Transportation-specific fields
          (rental trucks vs GAPP driver vs courier waybill vs self-collection) come from the delivery note record.
        </p>
      </div>

      <div className="bg-white border rounded-lg p-3 mb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <label className="text-[10px] font-bold text-gray-700">
          Report Level
          <select className="input-field mt-0.5 w-full" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="header">Header Level</option>
            <option value="item">Item Level</option>
          </select>
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Date From
          <input type="date" className="input-field mt-0.5 w-full" value={filters.date_from} onChange={(e) => setF('date_from', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Date To
          <input type="date" className="input-field mt-0.5 w-full" value={filters.date_to} onChange={(e) => setF('date_to', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Outbound Number
          <input className="input-field mt-0.5 w-full" value={filters.outbound_number} onChange={(e) => setF('outbound_number', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          GAPP PO
          <input className="input-field mt-0.5 w-full" value={filters.gapp_po} onChange={(e) => setF('gapp_po', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Customer Reference
          <input className="input-field mt-0.5 w-full" value={filters.customer_reference} onChange={(e) => setF('customer_reference', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Invoice Number
          <input className="input-field mt-0.5 w-full" value={filters.invoice_number} onChange={(e) => setF('invoice_number', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Customer Name
          <input className="input-field mt-0.5 w-full" value={filters.customer_name} onChange={(e) => setF('customer_name', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Sold To
          <input className="input-field mt-0.5 w-full" value={filters.sold_to} onChange={(e) => setF('sold_to', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Transportation Type
          <select
            className="input-field mt-0.5 w-full"
            value={filters.transportation_type}
            onChange={(e) => setF('transportation_type', e.target.value)}
          >
            {TRANSPORT_OPTS.map((o) => (
              <option key={o || 'all'} value={o}>
                {o || 'Any'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Carrier Name
          <input className="input-field mt-0.5 w-full" value={filters.carrier_name} onChange={(e) => setF('carrier_name', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Driver Name
          <input className="input-field mt-0.5 w-full" value={filters.driver_name} onChange={(e) => setF('driver_name', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Truck Type
          <input className="input-field mt-0.5 w-full" value={filters.truck_type} onChange={(e) => setF('truck_type', e.target.value)} />
        </label>
        <label className="text-[10px] font-bold text-gray-700">
          Delivery Status
          <input className="input-field mt-0.5 w-full" value={filters.status} onChange={(e) => setF('status', e.target.value)} placeholder="e.g. Delivered" />
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3 print:hidden">
        <button type="button" className="btn-primary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Apply filters'}
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportXlsx} disabled={!rows.length}>
          <FileSpreadsheet size={14} /> Export Excel
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportCsv} disabled={!rows.length}>
          <Download size={14} /> Export CSV
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => window.print()} disabled={!rows.length}>
          <Printer size={14} /> Print
        </button>
      </div>

      {err ? <div className="mb-2 text-[11px] text-red-700">{err}</div> : null}

      <div ref={printRef} className="bg-white border rounded-lg overflow-x-auto">
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
              <tr key={i} className="border-b border-gray-100">
                {columns.map((c) => (
                  <td key={c} className="px-2 py-1 whitespace-nowrap border-r border-gray-50 max-w-[220px] truncate">
                    {r[c] === null || r[c] === undefined ? '' : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length ? <div className="p-6 text-[11px] text-gray-500">Run a query with Apply filters.</div> : null}
      </div>
    </div>
  );
}
