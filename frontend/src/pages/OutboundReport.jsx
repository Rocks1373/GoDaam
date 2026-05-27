import { useCallback, useEffect, useState } from 'react';
import { FileDown } from 'lucide-react';
import { reportsApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import { exportJsonToExcel } from '../utils/exportExcel';

export default function OutboundReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [outbound_number, setOutboundNumber] = useState('');
  const [delivery, setDelivery] = useState('');
  const [customer, setCustomer] = useState('');

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await reportsApi.outbound({
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(outbound_number.trim() ? { outbound_number: outbound_number.trim() } : {}),
        ...(delivery.trim() ? { delivery: delivery.trim() } : {}),
        ...(customer.trim() ? { customer: customer.trim() } : {}),
      });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outboundReportSort = useCallback((r, k) => {
    if (k === 'picked_qty') return Number(r.picked_qty) || 0;
    if (k === 'picked_at') {
      const t = r.picked_at ? new Date(r.picked_at).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    if (k === 'item_status') return r.item_status ?? r.order_status ?? '';
    return r[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, outboundReportSort);

  return (
    <div className="max-w-[1600px]">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-bold text-gray-900 leading-tight">Outbound Report</h2>
          <p className="text-[11px] text-gray-600 mt-0.5">Pick transactions from mobile / FIFO workflow</p>
        </div>
        <button
          type="button"
          className="btn-secondary flex items-center gap-1 text-[11px]"
          disabled={!displayRows.length}
          onClick={() =>
            exportJsonToExcel(
              displayRows.map((r) => ({
                'Outbound #': r.outbound_number,
                Delivery: r.delivery,
                Customer: r.customer,
                'Part Number': r.part_number,
                'SAP Part Number': r.sap_part_number,
                Description: r.description,
                'Picked Qty': r.picked_qty,
                'Picked By': r.picked_by,
                'Picked At': r.picked_at,
                Status: r.item_status ?? r.order_status,
                Rack: r.rack_location,
              })),
              'outbound-report.xlsx',
              'Outbound Report'
            )
          }
        >
          <FileDown size={12} />
          Export Excel
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3 mb-3">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-[11px]">
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">From</span>
            <input type="date" className="border rounded px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">To</span>
            <input type="date" className="border rounded px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Outbound #</span>
            <input className="border rounded px-2 py-1" value={outbound_number} onChange={(e) => setOutboundNumber(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Delivery</span>
            <input className="border rounded px-2 py-1" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5 md:col-span-2">
            <span className="font-semibold text-gray-600">Customer</span>
            <input className="border rounded px-2 py-1" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="px-3 py-1.5 rounded-md text-[11px] font-bold border border-gray-300 bg-gray-50"
            >
              {loading ? '…' : 'Apply filters'}
            </button>
          </div>
        </div>
      </div>

      {err ? <div className="text-red-600 text-[11px] mb-2">{err}</div> : null}

      <div className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="bg-gray-50 text-left border-b border-gray-200">
              <SortTh
                bare
                columnKey="outbound_number"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Outbound #
              </SortTh>
              <SortTh
                bare
                columnKey="delivery"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Delivery
              </SortTh>
              <SortTh
                bare
                columnKey="customer"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Customer
              </SortTh>
              <SortTh
                bare
                columnKey="part_number"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Part
              </SortTh>
              <SortTh
                bare
                columnKey="picked_qty"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold text-right border-b border-gray-200"
              >
                Picked Qty
              </SortTh>
              <SortTh
                bare
                columnKey="picked_by"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Picked By
              </SortTh>
              <SortTh
                bare
                columnKey="picked_at"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Picked At
              </SortTh>
              <SortTh
                bare
                columnKey="item_status"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Status
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, idx) => (
              <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50/80">
                <td className="px-2 py-1.5 font-mono">{r.outbound_number}</td>
                <td className="px-2 py-1.5">{r.delivery || '—'}</td>
                <td className="px-2 py-1.5 max-w-[180px] truncate">{r.customer || '—'}</td>
                <td className="px-2 py-1.5 font-mono">{r.part_number}</td>
                <td className="px-2 py-1.5 text-right">{r.picked_qty}</td>
                <td className="px-2 py-1.5">{r.picked_by || '—'}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{r.picked_at || '—'}</td>
                <td className="px-2 py-1.5">{r.item_status ?? r.order_status ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading ? (
          <div className="p-6 text-center text-[11px] text-gray-500">No rows</div>
        ) : null}
      </div>
    </div>
  );
}
