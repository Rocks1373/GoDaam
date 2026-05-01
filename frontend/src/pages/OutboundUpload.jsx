import { useEffect, useMemo, useRef, useState } from 'react';
import { Truck, Upload, Wand2, ClipboardCheck, Send, Search, Trash2 } from 'lucide-react';
import { outboundGodamApi, stockByRackApi } from '../services/api';

export default function OutboundUpload() {
  const fileRef = useRef(null);
  const [uploadedOrders, setUploadedOrders] = useState([]);
  const [orders, setOrders] = useState([]);
  const [detail, setDetail] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [pageSearch, setPageSearch] = useState('');
  const [editQty, setEditQty] = useState({});
  const [editFifoQty, setEditFifoQty] = useState({});
  const [rackPicker, setRackPicker] = useState({ open: false, fifoId: null, rows: [], q: '' });

  const loadOrders = async () => {
    setLoading(true);
    setMsg('');
    try {
      const res = await outboundGodamApi.list({ limit: 200 });
      setOrders(res || []);
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredOrders = useMemo(() => {
    const q = pageSearch.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) => {
      const hay = [
        o.delivery,
        o.outbound_number,
        o.sales_doc,
        o.sales_order_number,
        o.customer_reference,
        o.name_1,
        o.customer_name,
        o.sold_to,
        o.vendor_name,
        o.status,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [orders, pageSearch]);

  const uploadFile = async (file) => {
    setLoading(true);
    setMsg('');
    try {
      const res = await outboundGodamApi.uploadExcel(file);
      setUploadedOrders(res.orders || []);
      await loadOrders();
      if ((res.orders || []).length === 1) {
        const d = await outboundGodamApi.get(res.orders[0].id);
        setDetail(d);
        setPreviewOpen(true);
      }
      setMsg(`Imported ${(res.orders || []).length} outbound(s).`);
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const loadDetail = async (id) => {
    setLoading(true);
    try {
      const d = await outboundGodamApi.get(id);
      setDetail(d);
      setPreviewOpen(true);
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveQty = async (itemId) => {
    if (!detail?.id) return;
    const raw = editQty[itemId];
    const next = Number(raw);
    if (!Number.isFinite(next) || next <= 0) {
      setMsg('Quantity must be a positive number.');
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const updated = await outboundGodamApi.updateItemQty(detail.id, itemId, next);
      setDetail(updated);
      setMsg('Quantity updated. FIFO refreshed.');
      await loadOrders();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const openRackPicker = async (fifo) => {
    const q = String(fifo.material || fifo.sap_part_number || '').trim();
    setRackPicker({ open: true, fifoId: fifo.id, rows: [], q });
    try {
      const rows = await stockByRackApi.search({ search: q, available_only: true, limit: 50 });
      setRackPicker((s) => ({ ...s, rows: rows || [] }));
    } catch {
      setRackPicker((s) => ({ ...s, rows: [] }));
    }
  };

  const saveFifoQty = async (fifoId) => {
    if (!detail?.id) return;
    const next = Number(editFifoQty[fifoId]);
    if (!Number.isFinite(next) || next <= 0) {
      setMsg('Suggested qty must be > 0');
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const updated = await outboundGodamApi.updateFifoQty(detail.id, fifoId, next);
      setDetail(updated);
      setMsg('FIFO line updated.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteFifoLine = async (fifoId) => {
    if (!detail?.id || !confirm('Delete this FIFO line?')) return;
    setLoading(true);
    setMsg('');
    try {
      const updated = await outboundGodamApi.removeFifoLine(detail.id, fifoId);
      setDetail(updated);
      setMsg('FIFO line deleted.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const checkStock = async () => {
    if (!detail?.id) return;
    setLoading(true);
    try {
      const d = await outboundGodamApi.checkStock(detail.id);
      setDetail(d);
      setMsg('Stock checked.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const generateFifo = async () => {
    if (!detail?.id) return;
    setLoading(true);
    try {
      await outboundGodamApi.generateFifo(detail.id);
      const d = await outboundGodamApi.get(detail.id);
      setDetail(d);
      setMsg('FIFO suggestions generated.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const sendForPick = async () => {
    if (!detail?.id || !confirm('Send this outbound for pick to mobile users?')) return;
    setLoading(true);
    try {
      await outboundGodamApi.sendForPick(detail.id);
      const d = await outboundGodamApi.get(detail.id);
      setDetail(d);
      setMsg('Sent for pick. Notifications queued.');
      setPreviewOpen(false);
      await loadOrders();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteOrder = async (id) => {
    if (!confirm(`Delete outbound #${id}? This cannot be undone.`)) return;
    setLoading(true);
    setMsg('');
    try {
      await outboundGodamApi.remove(id);
      setMsg('Outbound deleted.');
      await loadOrders();
      if (detail?.id === id) {
        setDetail(null);
        setPreviewOpen(false);
      }
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Outbound Upload</h2>
        <p className="text-[11px] text-gray-600">
          Excel columns: Delivery, Sales Doc., Customer Reference, Sold-to, Name 1, Material, SAP Part Number,
          Description, Delivery quantity
        </p>
      </div>

      <div className="app-page-toolbar flex flex-wrap items-center gap-2">
        <label className="btn-primary flex items-center gap-1 cursor-pointer">
          <Upload size={14} />
          Upload Excel
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
            }}
          />
        </label>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={loadOrders} disabled={loading}>
          Refresh
        </button>
        {loading ? <span className="text-[11px] text-gray-500">Working…</span> : null}
      </div>

      {msg ? <div className="mt-2 text-[11px] text-gray-700">{msg}</div> : null}

      {/* Search bar (required on all screens) */}
      <div className="app-page-toolbar">
        <div className="flex items-center gap-2 max-w-md">
          <Search size={14} className="text-gray-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search outbounds..."
            className="input-field flex-1"
            value={pageSearch}
            onChange={(e) => setPageSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="table-container mt-3">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="tbl-th">ID</th>
              <th className="tbl-th">Delivery</th>
              <th className="tbl-th">Sales Doc.</th>
              <th className="tbl-th">Customer name</th>
              <th className="tbl-th">Status</th>
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredOrders.map((o) => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{o.id}</td>
                <td className="tbl-td-nowrap">{o.delivery || o.outbound_number}</td>
                <td className="tbl-td-nowrap">{o.sales_doc || o.sales_order_number}</td>
                <td className="tbl-td">{o.customer_name || '-'}</td>
                <td className="tbl-td-nowrap">{o.status}</td>
                <td className="tbl-td-nowrap">
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="btn-secondary !py-1 !px-2" onClick={() => loadDetail(o.id)}>
                      Edit / workflow
                    </button>
                    {String(o.status || '').toLowerCase() === 'uploaded' ? (
                      <button
                        type="button"
                        className="btn-primary !py-1 !px-2 flex items-center gap-1"
                        onClick={async () => {
                          await loadDetail(o.id);
                          // send within modal with confirmation
                        }}
                        disabled={loading}
                        title="Open workflow then Send for pick"
                      >
                        <Send size={14} />
                        Send
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-secondary !py-1 !px-2 flex items-center gap-1 text-red-700"
                      onClick={() => deleteOrder(o.id)}
                      disabled={loading}
                      title="Delete outbound"
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!filteredOrders.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={5}>
                  No outbounds found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {previewOpen && detail ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-xl p-5 w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-lg">
            <div className="flex justify-between items-start gap-2 mb-3">
              <div>
                <div className="text-[10px] font-bold text-gray-500 uppercase">Header</div>
                <div className="text-sm font-bold text-gray-900">
                  Delivery {detail.delivery || detail.outbound_number} · Sales Doc.{' '}
                  {detail.sales_doc || detail.sales_order_number}
                </div>
                <div className="text-[11px] text-gray-700 mt-1">
                  Customer Ref: {detail.customer_reference || detail.customer_po_number || '-'} · Sold-to:{' '}
                  {detail.sold_to || detail.vendor_name || '-'} · Customer:{' '}
                  {detail.customer_name || detail.name_1 || '-'}
                </div>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setPreviewOpen(false)}>
                Close
              </button>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              <button type="button" className="btn-secondary flex items-center gap-1" onClick={checkStock} disabled={loading}>
                <ClipboardCheck size={14} />
                Check stock
              </button>
              <button type="button" className="btn-secondary flex items-center gap-1" onClick={generateFifo} disabled={loading}>
                <Wand2 size={14} />
                Generate FIFO
              </button>
              <button type="button" className="btn-primary flex items-center gap-1" onClick={sendForPick} disabled={loading}>
                <Send size={14} />
                Send for pick
              </button>
            </div>

            {(detail.items || []).some((it) => Number(it.shortage_qty || 0) > 0) ? (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] text-red-800">
                Some items have **shortage** (requested qty is higher than available stock). Reduce the quantity below, or add
                stock using **Stock In**, then re-check.
              </div>
            ) : null}

            <div className="text-[10px] font-bold text-gray-600 uppercase mb-1">Items</div>
            <div className="border rounded-lg overflow-x-auto mb-4">
              <table className="min-w-full text-[11px]">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="tbl-th">Material</th>
                    <th className="tbl-th">SAP PN</th>
                    <th className="tbl-th">Description</th>
                    <th className="tbl-th">Req (editable if shortage)</th>
                    <th className="tbl-th">Main avail</th>
                    <th className="tbl-th">FIFO</th>
                    <th className="tbl-th">Shortage</th>
                    <th className="tbl-th">Save</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.items || []).map((it) => (
                    <tr key={it.id} className={Number(it.shortage_qty || 0) > 0 ? 'bg-red-50' : ''}>
                      <td className="tbl-td">{it.material || it.part_number}</td>
                      <td className="tbl-td">{it.sap_part_number}</td>
                      <td className="tbl-td">{it.description}</td>
                      <td className="tbl-td-nowrap">
                        {Number(it.shortage_qty || 0) > 0 ? (
                          <input
                            className="input-field !py-1 !px-2 !text-[11px] w-24"
                            value={editQty[it.id] ?? String(it.required_qty ?? '')}
                            onChange={(e) => setEditQty((s) => ({ ...s, [it.id]: e.target.value }))}
                            inputMode="decimal"
                          />
                        ) : (
                          it.required_qty
                        )}
                      </td>
                      <td className="tbl-td-nowrap">{it.available_qty_main_stock ?? '-'}</td>
                      <td className="tbl-td-nowrap">{it.fifo_status ?? '-'}</td>
                      <td className="tbl-td-nowrap">{it.shortage_qty ?? '-'}</td>
                      <td className="tbl-td-nowrap">
                        {Number(it.shortage_qty || 0) > 0 ? (
                          <button
                            type="button"
                            className="btn-primary !py-1 !px-2"
                            onClick={() => saveQty(it.id)}
                            disabled={loading}
                          >
                            Save
                          </button>
                        ) : (
                          <span className="text-[11px] text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="text-[10px] font-bold text-gray-600 uppercase mb-1 flex items-center gap-1">
              <Truck size={12} /> FIFO suggested racks
            </div>
            <div className="border rounded-lg overflow-x-auto">
              <table className="min-w-full text-[11px]">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="tbl-th">Item</th>
                    <th className="tbl-th">Rack</th>
                    <th className="tbl-th">Suggest qty</th>
                    <th className="tbl-th">Seq</th>
                    <th className="tbl-th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.fifo_suggestions || []).map((f) => (
                    <tr key={f.id}>
                      <td className="tbl-td">{f.material || f.sap_part_number}</td>
                      <td className="tbl-td-nowrap">{f.rack_location}</td>
                      <td className="tbl-td-nowrap">
                        <input
                          className="input-field !py-1 !px-2 !text-[11px] w-24"
                          value={editFifoQty[f.id] ?? String(f.suggested_qty ?? '')}
                          onChange={(e) => setEditFifoQty((s) => ({ ...s, [f.id]: e.target.value }))}
                          inputMode="decimal"
                        />
                      </td>
                      <td className="tbl-td-nowrap">{f.fifo_sequence}</td>
                      <td className="tbl-td-nowrap">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className="btn-secondary !py-1 !px-2"
                            onClick={() => openRackPicker(f)}
                            disabled={loading}
                          >
                            Edit rack
                          </button>
                          <button
                            type="button"
                            className="btn-primary !py-1 !px-2"
                            onClick={() => saveFifoQty(f.id)}
                            disabled={loading}
                          >
                            Save qty
                          </button>
                          <button
                            type="button"
                            className="btn-secondary !py-1 !px-2 text-red-700"
                            onClick={() => deleteFifoLine(f.id)}
                            disabled={loading}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {rackPicker.open ? (
              <div className="mt-3 border rounded-lg p-3 bg-gray-50">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold text-gray-700">
                    Pick a rack for FIFO line #{rackPicker.fifoId}
                  </div>
                  <button type="button" className="btn-secondary !py-1 !px-2" onClick={() => setRackPicker({ open: false, fifoId: null, rows: [], q: '' })}>
                    Close
                  </button>
                </div>
                <div className="text-[11px] text-gray-600 mt-1">Showing racks matching: {rackPicker.q || '-'}</div>
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full text-[11px]">
                    <thead className="bg-white">
                      <tr>
                        <th className="tbl-th">Rack</th>
                        <th className="tbl-th">Part</th>
                        <th className="tbl-th">SAP</th>
                        <th className="tbl-th">Avail</th>
                        <th className="tbl-th">Action</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white">
                      {(rackPicker.rows || []).map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="tbl-td-nowrap">{r.rack_location}</td>
                          <td className="tbl-td-nowrap">{r.part_number}</td>
                          <td className="tbl-td-nowrap">{r.sap_part_number || '-'}</td>
                          <td className="tbl-td-nowrap">{r.available_qty}</td>
                          <td className="tbl-td-nowrap">
                            <button
                              type="button"
                              className="btn-primary !py-1 !px-2"
                              onClick={async () => {
                                try {
                                  const updated = await outboundGodamApi.changePickLocation(detail.id, {
                                    fifo_suggestion_id: rackPicker.fifoId,
                                    stock_by_rack_id: r.id,
                                  });
                                  // changePickLocation returns the updated fifo row; reload order
                                  const d = await outboundGodamApi.get(detail.id);
                                  setDetail(d);
                                  setMsg('Rack updated.');
                                  setRackPicker({ open: false, fifoId: null, rows: [], q: '' });
                                } catch (e) {
                                  setMsg(e.response?.data?.error || e.message);
                                }
                              }}
                              disabled={loading}
                            >
                              Select
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!rackPicker.rows.length ? (
                        <tr>
                          <td className="px-2 py-3 text-xs text-gray-500" colSpan={5}>
                            No racks found.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
