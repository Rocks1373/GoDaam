import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Filter, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import { stockByRackApi } from '../services/api';
import { formatDateDDMMYYYY } from '../utils/dateDisplay';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

const StockByRackSummary = ({ currentUser }) => {
  const isAdmin = String(currentUser?.role || '').toLowerCase() === 'admin';
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjRow, setAdjRow] = useState(null);
  const [deltaQty, setDeltaQty] = useState('');
  const [adjRemarks, setAdjRemarks] = useState('');
  const [feDate, setFeDate] = useState('');
  const [adjBusy, setAdjBusy] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [partNumber, setPartNumber] = useState('');
  const [sapPn, setSapPn] = useState('');
  const [rack, setRack] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);

  const params = useMemo(
    () => ({
      part_number: partNumber || undefined,
      sap_part_number: sapPn || undefined,
      rack_location: rack || undefined,
      available_only: availableOnly ? 'true' : 'false',
      limit: 500,
    }),
    [partNumber, sapPn, rack, availableOnly]
  );

  const fetchRows = async () => {
    try {
      setLoading(true);
      const data = await stockByRackApi.list(params);
      setRows(data || []);
    } catch (e) {
      console.error('Failed loading stock by rack summary:', e);
      alert('Failed to load summary: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  // Debounce filter inputs so typing stays smooth.
  useEffect(() => {
    const t = setTimeout(() => {
      fetchRows();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.part_number, params.sap_part_number, params.rack_location, params.available_only]);

  const exportExcel = () => {
    const exportRows = (rows || []).map((r) => ({
      part_number: r.part_number,
      sap_part_number: r.sap_part_number,
      description: r.description,
      rack_location: r.rack_location,
      total_in_qty: r.total_in_qty,
      total_out_qty: r.total_out_qty,
      available_qty: r.available_qty,
      first_entry_date: r.first_entry_date,
      last_updated: r.last_updated,
    }));
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock By Rack Summary');
    XLSX.writeFile(wb, 'stock-by-rack-summary.xlsx');
  };

  const exportCsv = () => {
    const exportRows = (rows || []).map((r) => ({
      part_number: r.part_number,
      sap_part_number: r.sap_part_number,
      description: r.description,
      rack_location: r.rack_location,
      total_in_qty: r.total_in_qty,
      total_out_qty: r.total_out_qty,
      available_qty: r.available_qty,
      first_entry_date: r.first_entry_date,
      last_updated: r.last_updated,
    }));
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stock-by-rack-summary.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const rackSummarySort = useCallback((r, k) => {
    if (['total_in_qty', 'total_out_qty', 'available_qty'].includes(k)) return Number(r[k]) || 0;
    if (k === 'first_entry_date' || k === 'last_updated') {
      const raw = r[k];
      const t = raw ? new Date(raw).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return r[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, rackSummarySort);

  const openAdjust = (r) => {
    setAdjRow(r);
    setDeltaQty('');
    setAdjRemarks('');
    setFeDate(r.first_entry_date ? String(r.first_entry_date).slice(0, 10) : '');
    setAdjOpen(true);
  };

  const submitAdjust = async () => {
    if (!adjRow?.id) return;
    const d = deltaQty === '' || deltaQty === null ? 0 : Number(deltaQty);
    if (!Number.isFinite(d)) {
      alert('Enter Δ qty as a number (e.g. +2 add, −9 deduct), or 0 if only changing first entry date.');
      return;
    }
    const avail = Number(adjRow.available_qty) || 0;
    if (d < 0 && avail + d < -1e-6) {
      alert(`Cannot go below zero. Maximum deduction is ${avail} (rack would become 0).`);
      return;
    }
    try {
      setAdjBusy(true);
      await stockByRackApi.adjust({
        stock_by_rack_id: adjRow.id,
        delta_qty: d,
        remarks: adjRemarks.trim() || undefined,
        first_entry_date: feDate.trim() || undefined,
      });
      setAdjOpen(false);
      setAdjRow(null);
      await fetchRows();
      alert('Saved. Rack updated and FIFO refreshed for all open outbound orders.');
    } catch (e) {
      alert(e.response?.data?.error || e.message || 'Adjust failed');
    } finally {
      setAdjBusy(false);
    }
  };

  return (
    <div>
      <div className="app-page-toolbar">
        <div className="flex flex-col lg:flex-row gap-2 lg:items-end">
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <div className="text-[10px] font-bold text-gray-600 mb-0.5">Part Number</div>
              <div className="flex items-center gap-1.5">
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  className="input-field flex-1"
                  value={partNumber}
                  onChange={(e) => setPartNumber(e.target.value)}
                  placeholder="Search part number..."
                />
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-gray-600 mb-0.5">SAP PN</div>
              <div className="flex items-center gap-1.5">
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  className="input-field flex-1"
                  value={sapPn}
                  onChange={(e) => setSapPn(e.target.value)}
                  placeholder="Search SAP PN..."
                />
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-gray-600 mb-0.5">Rack Location</div>
              <div className="flex items-center gap-1.5">
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  className="input-field flex-1"
                  value={rack}
                  onChange={(e) => setRack(e.target.value)}
                  placeholder="Search rack..."
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
              <Filter size={14} className="text-gray-400 flex-shrink-0" />
              <input
                type="checkbox"
                checked={availableOnly}
                onChange={(e) => setAvailableOnly(e.target.checked)}
              />
              Available only
            </label>
            <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportCsv}>
              <Download size={14} />
              Export CSV
            </button>
            <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportExcel}>
              <Download size={14} />
              Export Excel
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div>Loading summary…</div>
      ) : (
        <div className="table-container">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <SortTh columnKey="part_number" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Part Number
                </SortTh>
                <SortTh columnKey="sap_part_number" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  SAP PN
                </SortTh>
                <SortTh columnKey="description" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Description
                </SortTh>
                <SortTh columnKey="rack_location" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Rack Location
                </SortTh>
                <SortTh columnKey="total_in_qty" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Total In Qty
                </SortTh>
                <SortTh columnKey="total_out_qty" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Total Out Qty
                </SortTh>
                <SortTh columnKey="available_qty" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Available Qty
                </SortTh>
                <SortTh columnKey="first_entry_date" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  First Entry Date
                </SortTh>
                <SortTh columnKey="last_updated" sortKey={sortKey} direction={direction} onSort={requestSort}>
                  Last Updated
                </SortTh>
                {isAdmin ? (
                  <th className="px-2 py-2 text-left text-[10px] font-bold text-gray-600 uppercase tracking-wide whitespace-nowrap">
                    Admin
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(displayRows || []).map((r) => (
                <tr key={`${r.id}-${r.part_number}-${r.rack_location}`}>
                  <td className="tbl-td-nowrap">{r.part_number}</td>
                  <td className="tbl-td-nowrap">{r.sap_part_number || '-'}</td>
                  <td className="tbl-td">{r.description || '-'}</td>
                  <td className="tbl-td-nowrap">{r.rack_location}</td>
                  <td className="tbl-td-nowrap">{r.total_in_qty ?? 0}</td>
                  <td className="tbl-td-nowrap">{r.total_out_qty ?? 0}</td>
                  <td className="tbl-td-nowrap">{r.available_qty ?? 0}</td>
                  <td className="tbl-td-nowrap">
                    {r.first_entry_date ? formatDateDDMMYYYY(r.first_entry_date) : '-'}
                  </td>
                  <td className="tbl-td-nowrap">
                    {r.last_updated ? String(r.last_updated).slice(0, 19).replace('T', ' ') : '-'}
                  </td>
                  {isAdmin ? (
                    <td className="tbl-td-nowrap">
                      <button
                        type="button"
                        className="btn-secondary text-[10px] py-0.5 px-1.5"
                        onClick={() => openAdjust(r)}
                      >
                        Adjust
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adjOpen && adjRow ? (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 bg-black/40"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-4 border border-gray-200">
            <h3 className="text-sm font-bold text-gray-900 mb-1">Rack adjustment (admin)</h3>
            <p className="text-[11px] text-gray-600 mb-3">
              {adjRow.part_number} · {adjRow.rack_location} (system {adjRow.available_qty ?? 0}) — use{' '}
              <span className="font-mono">+2</span> to add, <span className="font-mono">-9</span> to remove 9, or{' '}
              <span className="font-mono">-{adjRow.available_qty ?? 0}</span> to clear rack to zero. Cannot go
              negative. FIFO rebuilt for open orders.
            </p>
            <div className="space-y-2">
              <div>
                <label className="text-[10px] font-bold text-gray-600">Δ Qty (+ / −)</label>
                <input
                  className="input-field w-full mt-0.5"
                  value={deltaQty}
                  onChange={(e) => setDeltaQty(e.target.value)}
                  placeholder="e.g. -2 or +3 (0 = qty unchanged)"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-600">First entry date (FIFO order)</label>
                <input
                  type="date"
                  className="input-field w-full mt-0.5"
                  value={feDate}
                  onChange={(e) => setFeDate(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[10px] font-bold text-gray-600">Remarks</label>
                <textarea
                  className="input-field w-full mt-0.5 min-h-[64px]"
                  value={adjRemarks}
                  onChange={(e) => setAdjRemarks(e.target.value)}
                  placeholder="Reason / reference"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                className="btn-secondary"
                disabled={adjBusy}
                onClick={() => {
                  setAdjOpen(false);
                  setAdjRow(null);
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={adjBusy} onClick={submitAdjust}>
                {adjBusy ? 'Saving…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default StockByRackSummary;

