import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileDown } from 'lucide-react';
import { reportsApi, inboundApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import InboundFilterAutocomplete from '../components/InboundFilterAutocomplete';
import { exportJsonToExcel } from '../utils/exportExcel';

export default function InboundReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [batch, setBatch] = useState('');
  const [vendor, setVendor] = useState('');
  const [lpo, setLpo] = useState('');
  const [sapPo, setSapPo] = useState('');
  const [invoice, setInvoice] = useState('');
  const [partNumber, setPartNumber] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [applyBusy, setApplyBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await reportsApi.inbound({
        ...(batch.trim() ? { batch: batch.trim() } : {}),
        ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
        ...(lpo.trim() ? { lpo: lpo.trim() } : {}),
        ...(sapPo.trim() ? { sap_po: sapPo.trim() } : {}),
        ...(invoice.trim() ? { invoice: invoice.trim() } : {}),
        ...(partNumber.trim() ? { part_number: partNumber.trim() } : {}),
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

  const inboundSortValue = useCallback((r, k) => {
    if (['total_qty', 'putaway_qty', 'remaining_qty', 'pending_lines'].includes(k)) return Number(r[k]) || 0;
    if (k === 'last_updated') {
      const t = r.last_updated ? new Date(r.last_updated).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return r[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, inboundSortValue);

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
            className="btn-secondary flex items-center gap-1 text-[11px]"
            disabled={!displayRows.length}
            onClick={() =>
              exportJsonToExcel(
                displayRows.map((r) => ({
                  Batch: r.batch_name,
                  Vendor: r.vendor_name,
                  LPO: r.lpo,
                  'SAP PO': r.sap_po,
                  Invoice: r.invoice_number,
                  'Part Number': r.part_number,
                  'SAP Part Number': r.sap_part_number,
                  Description: r.description,
                  'Total Qty': r.total_qty,
                  'Putaway Qty': r.putaway_qty,
                  Remaining: r.remaining_qty,
                  'Item Status': r.item_status,
                  'Pending Lines': r.pending_lines,
                  'Last Updated': r.last_updated,
                })),
                'inbound-putaway-report.xlsx',
                'Inbound'
              )
            }
          >
            <FileDown size={12} />
            Export Excel
          </button>
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
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2 text-[11px]">
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Batch</span>
            <input className="border rounded px-2 py-1" value={batch} onChange={(e) => setBatch(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-600">Vendor</span>
            <input className="border rounded px-2 py-1" value={vendor} onChange={(e) => setVendor(e.target.value)} />
          </label>
          <InboundFilterAutocomplete
            label="LPO"
            value={lpo}
            onChange={setLpo}
            fetchSuggestions={(q) => reportsApi.inboundFilterSuggestions('lpo', q)}
          />
          <InboundFilterAutocomplete
            label="SAP PO"
            value={sapPo}
            onChange={setSapPo}
            fetchSuggestions={(q) => reportsApi.inboundFilterSuggestions('sap_po', q)}
          />
          <InboundFilterAutocomplete
            label="Invoice"
            value={invoice}
            onChange={setInvoice}
            fetchSuggestions={(q) => reportsApi.inboundFilterSuggestions('invoice', q)}
          />
          <InboundFilterAutocomplete
            label="Part #"
            value={partNumber}
            onChange={setPartNumber}
            fetchSuggestions={(q) => reportsApi.inboundFilterSuggestions('part', q)}
          />
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
              <th className="px-2 py-2 w-10" aria-hidden />
              <SortTh
                bare
                columnKey="batch_name"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Batch
              </SortTh>
              <SortTh
                bare
                columnKey="vendor_name"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Vendor
              </SortTh>
              <SortTh
                bare
                columnKey="lpo"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                LPO
              </SortTh>
              <SortTh
                bare
                columnKey="sap_po"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                SAP PO
              </SortTh>
              <SortTh
                bare
                columnKey="invoice_number"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Invoice
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
                columnKey="description"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Description
              </SortTh>
              <SortTh
                bare
                columnKey="total_qty"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold text-right border-b border-gray-200"
              >
                Total
              </SortTh>
              <SortTh
                bare
                columnKey="putaway_qty"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold text-right border-b border-gray-200"
              >
                Putaway
              </SortTh>
              <SortTh
                bare
                columnKey="remaining_qty"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold text-right border-b border-gray-200"
              >
                Remaining
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
              <SortTh
                bare
                columnKey="pending_lines"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Pending rack lines
              </SortTh>
              <SortTh
                bare
                columnKey="last_updated"
                sortKey={sortKey}
                direction={direction}
                onSort={requestSort}
                className="px-2 py-2 font-bold border-b border-gray-200"
              >
                Last updated
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r) => {
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
                  <td className="px-2 py-1.5">{r.lpo || '—'}</td>
                  <td className="px-2 py-1.5">{r.sap_po || '—'}</td>
                  <td className="px-2 py-1.5">{r.invoice_number || '—'}</td>
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
