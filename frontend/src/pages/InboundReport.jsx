import { useEffect, useMemo, useState } from 'react';
import { inboundApi } from '../services/api';

export default function InboundReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [batch, setBatch] = useState('');
  const [vendor, setVendor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [applyBusy, setApplyBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await inboundApi.putawayReport({
        ...(batch.trim() ? { batch: batch.trim() } : {}),
        ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(status ? { status } : {}),
      });
      setRows(Array.isArray(data) ? data : []);
      setSelected(new Set());
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

  const selectableIds = useMemo(
    () => new Set(rows.filter((r) => Number(r.pending_lines) > 0).map((r) => r.inbound_item_id)),
    [rows]
  );

  const toggle = (id) => {
    if (!selectableIds.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(selectableIds));
  };

  const clearSel = () => setSelected(new Set());

  const applyRack = async () => {
    if (!selected.size) return;
    setApplyBusy(true);
    setErr('');
    try {
      await inboundApi.applyPutawayToRack([...selected]);
      await load();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Apply failed');
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <div className="max-w-[1600px]">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-base font-bold text-gray-900 leading-tight">Inbound Putaway Report</h2>
          <p className="text-[11px] text-gray-600 mt-0.5">
            Confirm putaway lines to update Stock By Rack (FIFO summary). Rows need pending lines from mobile putaway.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={applyRack}
            disabled={applyBusy || !selected.size}
            className="px-3 py-1.5 rounded-md text-[11px] font-bold bg-primary-600 text-white disabled:opacity-40"
          >
            {applyBusy ? 'Applying…' : 'Update to Stock By Rack'}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3 mb-3">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-[11px]">
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Batch</span>
            <input className="border rounded px-2 py-1" value={batch} onChange={(e) => setBatch(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Vendor</span>
            <input className="border rounded px-2 py-1" value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">From</span>
            <input type="date" className="border rounded px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">To</span>
            <input type="date" className="border rounded px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Status</span>
            <select className="border rounded px-2 py-1" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="Pending">Pending</option>
              <option value="Partial">Partial</option>
              <option value="Completed">Completed</option>
            </select>
          </label>
          <div className="flex items-end gap-2">
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
        <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 text-[11px]">
          <button type="button" className="font-bold text-primary-700" onClick={selectAll}>
            Select all (pending)
          </button>
          <button type="button" className="font-bold text-gray-600" onClick={clearSel}>
            Clear
          </button>
          <span className="text-gray-500">{selected.size} selected</span>
        </div>
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="bg-gray-50 text-left border-b border-gray-200">
              <th className="px-2 py-2 w-10"></th>
              <th className="px-2 py-2 font-bold">Batch</th>
              <th className="px-2 py-2 font-bold">Vendor</th>
              <th className="px-2 py-2 font-bold">Part</th>
              <th className="px-2 py-2 font-bold">Description</th>
              <th className="px-2 py-2 font-bold text-right">Total</th>
              <th className="px-2 py-2 font-bold text-right">Putaway</th>
              <th className="px-2 py-2 font-bold text-right">Remaining</th>
              <th className="px-2 py-2 font-bold">Status</th>
              <th className="px-2 py-2 font-bold">Pending rack lines</th>
              <th className="px-2 py-2 font-bold">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const id = r.inbound_item_id;
              const canSel = selectableIds.has(id);
              return (
                <tr key={`${id}-${r.batch_id}`} className="border-b border-gray-100 hover:bg-gray-50/80">
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      disabled={!canSel}
                      onChange={() => toggle(id)}
                    />
                  </td>
                  <td className="px-2 py-1.5 font-semibold">{r.batch_name}</td>
                  <td className="px-2 py-1.5">{r.vendor_name || '—'}</td>
                  <td className="px-2 py-1.5 font-mono">{r.part_number}</td>
                  <td className="px-2 py-1.5 max-w-[220px] truncate">{r.description || '—'}</td>
                  <td className="px-2 py-1.5 text-right">{r.total_qty}</td>
                  <td className="px-2 py-1.5 text-right">{r.putaway_qty}</td>
                  <td className="px-2 py-1.5 text-right">{r.remaining_qty}</td>
                  <td className="px-2 py-1.5">{r.item_status}</td>
                  <td className="px-2 py-1.5">{r.pending_lines}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{r.last_updated || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && !loading ? (
          <div className="p-6 text-center text-[11px] text-gray-500">No rows</div>
        ) : null}
      </div>
    </div>
  );
}
