import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Truck, Upload, Wand2, ClipboardCheck, Send, Search, Trash2, PackageCheck, Undo2, FileText } from 'lucide-react';
import api, { outboundGodamApi, pickedOrdersApi, stockByRackApi } from '../services/api';
import { reportUploadError, reportUploadResult } from '../utils/uploadErrorReport';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

function pickQty(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function PickLivePanel({ detail, loading, onRefresh }) {
  const pp = detail?.pick_progress;
  const txs = detail?.picked_transactions || [];
  const po = detail?.picked_order;
  if (!detail?.id) return null;
  const full = Boolean(pp?.fully_picked);
  return (
    <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="text-[10px] font-bold text-emerald-900 uppercase tracking-wide">Pick progress (live)</div>
        <button type="button" className="btn-secondary !py-0.5 !px-2 text-[10px]" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-[11px] text-emerald-950 mb-3">
        <div className="rounded bg-white/80 border border-emerald-100 px-2 py-1.5">
          <div className="text-[9px] font-semibold text-emerald-800 uppercase">Total qty</div>
          <div>
            Picked <strong>{pickQty(pp?.total_picked_qty).toLocaleString()}</strong> / required{' '}
            <strong>{pickQty(pp?.total_required_qty).toLocaleString()}</strong>
          </div>
          <div className="text-emerald-800 mt-0.5">
            Remaining: <strong>{pickQty(pp?.remaining_qty).toLocaleString()}</strong>
          </div>
        </div>
        <div className="rounded bg-white/80 border border-emerald-100 px-2 py-1.5">
          <div className="text-[9px] font-semibold text-emerald-800 uppercase">Lines</div>
          <div>
            Complete <strong>{pickQty(pp?.lines_complete)}</strong> / <strong>{pickQty(pp?.lines_total)}</strong>
          </div>
        </div>
        <div className="rounded bg-white/80 border border-emerald-100 px-2 py-1.5 sm:col-span-2">
          <div className="text-[9px] font-semibold text-emerald-800 uppercase">Pick confirmed (mobile)</div>
          {po ? (
            <div>
              <span className="font-semibold">{po.confirmed_by_user_name || '—'}</span>
              {po.confirmed_at ? <span className="text-gray-600"> · {String(po.confirmed_at).slice(0, 19)}</span> : null}
            </div>
          ) : (
            <span className="text-gray-600">Not confirmed yet</span>
          )}
        </div>
        <div className="rounded border px-2 py-1.5 sm:col-span-2 lg:col-span-4 bg-white/90 border-emerald-200">
          <span className={`font-bold ${full ? 'text-emerald-800' : 'text-amber-800'}`}>
            {full ? 'All lines picked — ready for confirm / DN' : 'Still picking — see rack lines below'}
          </span>
        </div>
      </div>
      <div className="text-[10px] font-bold text-emerald-900 uppercase mb-1">Pick transactions (who · rack · qty)</div>
      <div className="border border-emerald-100 rounded-lg overflow-x-auto max-h-[220px] overflow-y-auto bg-white">
        <table className="min-w-full text-[10px]">
          <thead className="bg-emerald-100/80 sticky top-0">
            <tr>
              <th className="tbl-th text-left">When</th>
              <th className="tbl-th text-left">Picker</th>
              <th className="tbl-th text-left">Part</th>
              <th className="tbl-th text-right">Qty</th>
              <th className="tbl-th text-left">Rack</th>
              <th className="tbl-th text-left">Method</th>
            </tr>
          </thead>
          <tbody>
            {txs.length ? (
              txs.map((t) => (
                <tr key={t.id} className="border-b border-emerald-50">
                  <td className="tbl-td-nowrap whitespace-nowrap">{t.picked_at ? String(t.picked_at).slice(0, 19) : '—'}</td>
                  <td className="tbl-td max-w-[8rem] truncate" title={t.user_name || ''}>
                    {t.user_name || `user #${t.user_id || '—'}`}
                  </td>
                  <td className="tbl-td max-w-[10rem] truncate" title={t.material || t.sap_part_number || ''}>
                    {t.material || t.sap_part_number || '—'}
                  </td>
                  <td className="tbl-td text-right">{pickQty(t.picked_qty)}</td>
                  <td className="tbl-td font-mono max-w-[8rem] truncate" title={t.rack_location || ''}>
                    {t.rack_location || '—'}
                  </td>
                  <td className="tbl-td-nowrap">
                    {t.picked_method || '—'}
                    {Number(t.is_manual_pick) ? ' · admin' : ''}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="tbl-td text-gray-500 py-2" colSpan={6}>
                  No pick scans yet — quantities will appear here as pickers confirm from mobile (or after admin manual pick).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function statusBadgeClass(statusRaw) {
  const s = String(statusRaw || '').trim().toLowerCase();
  if (s === 'delivered') return 'bg-emerald-100 text-emerald-900 border-emerald-200';
  if (s === 'picked' || s === 'checked') return 'bg-sky-100 text-sky-900 border-sky-200';
  if (s === 'picking') return 'bg-amber-50 text-amber-900 border-amber-200';
  if (s.includes('sent') && s.includes('pick')) return 'bg-amber-100 text-amber-950 border-amber-300';
  if (s.includes('stock')) return 'bg-violet-50 text-violet-900 border-violet-200';
  if (s === 'uploaded') return 'bg-slate-100 text-slate-800 border-slate-200';
  return 'bg-gray-50 text-gray-800 border-gray-200';
}

const ORDER_ATTACHMENT_STAGES = [
  { stage: 'order_created', title: 'At order creation' },
  { stage: 'post_delivery', title: 'After delivery' },
];

export default function OutboundUpload({ currentUser }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fileRef = useRef(null);
  const docRefCreated = useRef(null);
  const docRefPost = useRef(null);
  const [hubTab, setHubTab] = useState(() => (searchParams.get('tab') === 'delivered' ? 'delivered' : 'active'));
  const [pickedMap, setPickedMap] = useState({});
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
  const [manualPick, setManualPick] = useState({ override: false, reason: '' });
  const isAdmin = String(currentUser?.role || '').toLowerCase() === 'admin';
  const canUploadOutbound = isAdmin || Boolean(currentUser?.permissions?.can_upload_outbound);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const [res, pickedRows] = await Promise.all([
        outboundGodamApi.list({ limit: 500 }),
        isAdmin ? pickedOrdersApi.list({}).catch(() => []) : Promise.resolve([]),
      ]);
      setOrders(res || []);
      const m = {};
      for (const po of pickedRows || []) {
        const oid = Number(po.outbound_order_id);
        if (oid) m[oid] = po;
      }
      setPickedMap(m);
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  const setHubTabFromUi = (tab) => {
    setHubTab(tab);
    if (tab === 'delivered') setSearchParams({ tab: 'delivered' }, { replace: true });
    else setSearchParams({}, { replace: true });
  };

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'delivered') setHubTab('delivered');
    if (t === 'active') setHubTab('active');
  }, [searchParams]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const filteredOrders = useMemo(() => {
    const q = pageSearch.trim().toLowerCase();
    const isDelivered = (o) => String(o.status || '').trim().toLowerCase() === 'delivered';
    let rows = hubTab === 'delivered' ? orders.filter(isDelivered) : orders.filter((o) => !isDelivered(o));
    if (!q) return rows;
    return rows.filter((o) => {
      const po = pickedMap[o.id];
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
        po?.confirmed_by_user_name,
        po?.confirmed_at,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [orders, pageSearch, hubTab, pickedMap]);

  const orderSortValue = useCallback((o, k) => {
    if (k === 'id') return Number(o.id) || 0;
    if (k === 'delivery') return o.delivery || o.outbound_number || '';
    if (k === 'sales_doc') return o.sales_doc || o.sales_order_number || '';
    if (k === 'customer_name') return o.customer_name || '';
    if (k === 'status') return o.status || '';
    return o[k];
  }, []);

  const {
    displayRows: orderDisplayRows,
    sortKey: orderSortKey,
    direction: orderDir,
    requestSort: orderRequestSort,
  } = useTableSort(filteredOrders, orderSortValue);

  const itemSortValue = useCallback((it, k) => {
    if (k === 'material') return it.material || it.part_number || '';
    if (k === 'required_qty') return Number(it.required_qty) || 0;
    if (k === 'picked_qty') return Number(it.picked_qty) || 0;
    if (k === 'line_remaining_qty') {
      return Math.max(0, pickQty(it.required_qty) - pickQty(it.picked_qty));
    }
    if (k === 'available_qty_main_stock') {
      const v = it.available_qty_main_stock;
      if (v === null || v === undefined || v === '-') return Number.NEGATIVE_INFINITY;
      const n = Number(v);
      return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
    }
    if (k === 'shortage_qty') return Number(it.shortage_qty) || 0;
    return it[k];
  }, []);

  const {
    displayRows: itemDisplayRows,
    sortKey: itemSortKey,
    direction: itemDir,
    requestSort: itemRequestSort,
  } = useTableSort(detail?.items, itemSortValue);

  const fifoSortValue = useCallback((f, k) => {
    if (k === 'material') return f.material || f.sap_part_number || '';
    if (k === 'suggested_qty') return Number(f.suggested_qty) || 0;
    if (k === 'fifo_picked_qty') return Number(f.fifo_picked_qty) || 0;
    if (k === 'fifo_remaining_qty') {
      return Math.max(0, pickQty(f.suggested_qty) - pickQty(f.fifo_picked_qty));
    }
    if (k === 'fifo_sequence') return Number(f.fifo_sequence) || 0;
    return f[k];
  }, []);

  const {
    displayRows: fifoDisplayRows,
    sortKey: fifoSortKey,
    direction: fifoDir,
    requestSort: fifoRequestSort,
  } = useTableSort(detail?.fifo_suggestions, fifoSortValue);

  const rackSortValue = useCallback((r, k) => {
    if (k === 'available_qty') return Number(r.available_qty) || 0;
    return r[k];
  }, []);

  const {
    displayRows: rackDisplayRows,
    sortKey: rackSortKey,
    direction: rackDir,
    requestSort: rackRequestSort,
  } = useTableSort(rackPicker.rows, rackSortValue);

  const uploadFile = async (file) => {
    setLoading(true);
    setMsg('');
    try {
      const res = await outboundGodamApi.uploadExcel(file);
      setUploadedOrders(res.orders || []);
      await loadOrders();
      reportUploadResult(res, { label: 'Outbound upload', filenamePrefix: 'outbound-upload', notify: setMsg });
      if ((res.orders || []).length === 1) {
        const d = await outboundGodamApi.get(res.orders[0].id);
        setDetail(d);
        setPreviewOpen(true);
      }
    } catch (e) {
      reportUploadError(e, { label: 'Outbound upload', filenamePrefix: 'outbound-upload', notify: setMsg });
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

  const confirmManualPick = async () => {
    if (!detail?.id) return;
    if (!isAdmin) {
      setMsg('Manual Pick is Admin only.');
      return;
    }
    const reason = manualPick.reason.trim();
    if (manualPick.override && !reason) {
      setMsg('Override reason is required.');
      return;
    }
    if (!confirm('Confirm manual pick for this outbound using the FIFO suggestions shown?')) return;
    setLoading(true);
    setMsg('');
    try {
      const res = await outboundGodamApi.manualPick(detail.id, {
        override: manualPick.override,
        reason: manualPick.override ? reason : '',
      });
      setDetail(res.order || (await outboundGodamApi.get(detail.id)));
      const partial =
        res.partial_pick && Number(res.shortfall_line_count) > 0
          ? ` (${res.shortfall_line_count} line(s) had no rack qty — enable Override + reason to close qty on paper, or add stock and pick again.)`
          : '';
      setMsg(`Manual pick completed. Status: ${res.status}.${partial}`);
      setManualPick({ override: false, reason: '' });
      await loadOrders();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const markDelivered = async () => {
    if (!detail?.id) return;
    if (
      !confirm(
        'Mark this outbound as delivered? Main stock sold counts will increase (same rules as Delivery Note deliver). Invoice number must be set on the order.'
      )
    ) {
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      await outboundGodamApi.markDelivered(detail.id);
      const d = await outboundGodamApi.get(detail.id);
      setDetail(d);
      setMsg('Marked delivered. Stock deducted.');
      await loadOrders();
      setPreviewOpen(false);
      setHubTabFromUi('delivered');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const reverseDelivery = async () => {
    if (!detail?.id) return;
    if (
      !confirm(
        'Reverse delivery for this outbound? This restores main stock sold quantities and removes the delivery audit rows. Physical returns must still be received via Stock In / rack if goods came back. Continue?'
      )
    ) {
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const res = await outboundGodamApi.reverseDelivery(detail.id);
      const d = await outboundGodamApi.get(detail.id);
      setDetail(d);
      setMsg(res?.note || 'Delivery reversed.');
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

  const uploadOrderDocFile = async (stage) => {
    if (!detail?.id) return;
    const ref = stage === 'order_created' ? docRefCreated : docRefPost;
    const f = ref.current?.files?.[0];
    if (!f) {
      setMsg('Choose a file to upload.');
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      await outboundGodamApi.uploadOrderDocument(detail.id, f, stage);
      if (ref.current) ref.current.value = '';
      const d = await outboundGodamApi.get(detail.id);
      setDetail(d);
      setMsg('Attachment saved.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteOrderDoc = async (docId) => {
    if (!detail?.id || !window.confirm('Remove this attachment?')) return;
    setLoading(true);
    setMsg('');
    try {
      await outboundGodamApi.deleteOrderDocument(detail.id, docId);
      const d = await outboundGodamApi.get(detail.id);
      setDetail(d);
      setMsg('Attachment removed.');
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  const downloadOrderDoc = async (row) => {
    const stripped = String(row?.file_path || '')
      .replace(/^uploads\//, '')
      .replace(/^\/+/, '');
    if (!stripped) return;
    try {
      const res = await api.get(`/files/uploads/${stripped}`, { responseType: 'blob' });
      const blob = res.data;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = row.file_name || 'download';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(e.response?.data?.error || e.message || 'Download failed');
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Outbound &amp; pick</h2>
        <p className="text-[11px] text-gray-600">
          Upload outbounds, run FIFO / send for pick, and track pick confirmation. Delivered orders move to the{' '}
          <strong>Delivered</strong> tab. Excel columns: Delivery, Sales Doc., Customer Reference, Sold-to, Name 1, Material,
          SAP Part Number, Description, Delivery quantity
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold ${
            hubTab === 'active' ? 'border-primary-600 bg-primary-50 text-primary-900' : 'border-gray-200 bg-white text-gray-700'
          }`}
          onClick={() => setHubTabFromUi('active')}
        >
          Outbound &amp; pick (active)
        </button>
        <button
          type="button"
          className={`rounded-lg border px-3 py-1.5 text-[11px] font-bold ${
            hubTab === 'delivered' ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-gray-200 bg-white text-gray-700'
          }`}
          onClick={() => setHubTabFromUi('delivered')}
        >
          Delivered
        </button>
      </div>

      <div className="app-page-toolbar flex flex-wrap items-center gap-2">
        {canUploadOutbound ? (
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
        ) : null}
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
              <SortTh columnKey="id" sortKey={orderSortKey} direction={orderDir} onSort={orderRequestSort}>
                ID
              </SortTh>
              <SortTh columnKey="delivery" sortKey={orderSortKey} direction={orderDir} onSort={orderRequestSort}>
                Delivery
              </SortTh>
              <SortTh columnKey="sales_doc" sortKey={orderSortKey} direction={orderDir} onSort={orderRequestSort}>
                Sales Doc.
              </SortTh>
              <SortTh columnKey="customer_name" sortKey={orderSortKey} direction={orderDir} onSort={orderRequestSort}>
                Customer name
              </SortTh>
              <SortTh columnKey="status" sortKey={orderSortKey} direction={orderDir} onSort={orderRequestSort}>
                Status
              </SortTh>
              {isAdmin ? <th className="tbl-th text-left">Pick confirmed</th> : null}
              <th className="tbl-th text-left">Delivery note</th>
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {orderDisplayRows.map((o) => {
              const po = pickedMap[o.id];
              const delKey = o.delivery || o.outbound_number || '';
              const stLower = String(o.status || '').toLowerCase();
              return (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">
                  <button
                    type="button"
                    className="text-primary-700 font-semibold hover:underline"
                    onClick={() => loadDetail(o.id)}
                    title="Open pick details & workflow"
                  >
                    {o.id}
                  </button>
                </td>
                <td className="tbl-td-nowrap">
                  <button
                    type="button"
                    className="text-primary-700 font-semibold hover:underline text-left"
                    onClick={() => loadDetail(o.id)}
                    title="Open pick details & workflow"
                  >
                    {o.delivery || o.outbound_number}
                  </button>
                </td>
                <td className="tbl-td-nowrap">{o.sales_doc || o.sales_order_number}</td>
                <td className="tbl-td">{o.customer_name || '-'}</td>
                <td className="tbl-td-nowrap">
                  <span
                    className={`inline-flex max-w-[10rem] truncate rounded border px-1.5 py-0.5 text-[10px] font-bold ${statusBadgeClass(o.status)}`}
                    title={o.status || ''}
                  >
                    {o.status || '—'}
                  </span>
                </td>
                {isAdmin ? (
                  <td className="tbl-td text-[10px] leading-snug max-w-[9rem]">
                    {po ? (
                      <>
                        <div className="font-semibold text-gray-800 truncate" title={po.confirmed_by_user_name || ''}>
                          {po.confirmed_by_user_name || '—'}
                        </div>
                        <div className="text-gray-500">{String(po.confirmed_at || '').slice(0, 19) || '—'}</div>
                      </>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                ) : null}
                <td className="tbl-td align-top">
                  <div className="flex flex-col gap-1 max-w-[11rem]">
                    <div className="text-[9px] text-gray-500 leading-tight line-clamp-2 font-mono">
                      {delKey ? `DN · ${delKey}` : '—'}
                    </div>
                    <button
                      type="button"
                      className="btn-secondary !py-1 !px-1.5 flex items-center gap-1 w-fit text-[10px]"
                      title="Open delivery note for this outbound"
                      onClick={() => navigate(`/delivery-note?outbound=${encodeURIComponent(delKey)}`)}
                    >
                      <FileText size={12} />
                      Open DN
                    </button>
                  </div>
                </td>
                <td className="tbl-td-nowrap">
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className="btn-secondary !py-1 !px-2" onClick={() => loadDetail(o.id)}>
                      Edit / workflow
                    </button>
                    {isAdmin && stLower === 'uploaded' ? (
                      <button
                        type="button"
                        className="btn-primary !py-1 !px-2 flex items-center gap-1"
                        onClick={async () => {
                          await loadDetail(o.id);
                        }}
                        disabled={loading}
                        title="Open workflow then Send for pick"
                      >
                        <Send size={14} />
                        Send
                      </button>
                    ) : null}
                    {canUploadOutbound ? (
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
                    ) : null}
                  </div>
                </td>
              </tr>
            );})}
            {!orderDisplayRows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={isAdmin ? 8 : 7}>
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
              <div className="flex flex-col items-end gap-2">
                {detail.sales_doc || detail.sales_order_number ? (
                  <Link
                    className="btn-secondary !py-1 !px-2 text-[11px]"
                    to={`/sales-order-documents?so=${encodeURIComponent(
                      String(detail.sales_doc || detail.sales_order_number).trim()
                    )}`}
                  >
                    Sales Order Documents
                  </Link>
                ) : null}
                <button type="button" className="btn-secondary" onClick={() => setPreviewOpen(false)}>
                  Close
                </button>
              </div>
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
              {isAdmin ? (
                <button type="button" className="btn-primary flex items-center gap-1" onClick={sendForPick} disabled={loading}>
                  <Send size={14} />
                  Send for pick
                </button>
              ) : null}
              {isAdmin ? (
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1 border-blue-200"
                  onClick={confirmManualPick}
                  disabled={loading || String(detail.status || '').toLowerCase() === 'picked'}
                  title="Admin-only pick without mobile scanning"
                >
                  <PackageCheck size={14} />
                  Manual Pick
                </button>
              ) : null}
              {String(detail.status || '').toLowerCase() === 'delivered' ? (
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1 border-amber-300 text-amber-900"
                  onClick={reverseDelivery}
                  disabled={loading}
                  title="Undo mark-delivered (restore main stock sold counts)"
                >
                  <Undo2 size={14} />
                  Reverse delivery
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1 border-emerald-200"
                  onClick={markDelivered}
                  disabled={loading}
                  title="Requires invoice number on this outbound (same as DN deliver)"
                >
                  <PackageCheck size={14} />
                  Mark delivered
                </button>
              )}
            </div>

            <PickLivePanel detail={detail} loading={loading} onRefresh={() => loadDetail(detail.id)} />

            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-[10px] font-bold text-gray-600 uppercase mb-1">Sales order attachments</div>
              <p className="text-[10px] text-gray-600 mb-3 leading-snug">
                Optional files tied to this outbound (sales order), by lifecycle stage. Separate from the driver POD on the delivery note.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {ORDER_ATTACHMENT_STAGES.map(({ stage, title }) => {
                  const rows = (detail.order_documents || []).filter((d) => d.upload_stage === stage);
                  const ref = stage === 'order_created' ? docRefCreated : docRefPost;
                  return (
                    <div key={stage} className="rounded border bg-white p-2.5">
                      <div className="text-[11px] font-bold text-gray-800 mb-1.5">{title}</div>
                      <ul className="space-y-1 mb-2 min-h-[2rem]">
                        {rows.length ? (
                          rows.map((d) => (
                            <li key={d.id} className="flex items-center justify-between gap-1 text-[10px]">
                              <button
                                type="button"
                                className="text-left text-primary-700 hover:underline truncate max-w-[70%]"
                                onClick={() => downloadOrderDoc(d)}
                              >
                                {d.file_name || 'file'}
                              </button>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {canUploadOutbound ? (
                                  <button
                                    type="button"
                                    className="btn-secondary !py-0.5 !px-1 text-red-700"
                                    title="Remove"
                                    onClick={() => deleteOrderDoc(d.id)}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                ) : null}
                              </div>
                            </li>
                          ))
                        ) : (
                          <li className="text-[10px] text-gray-400">No files yet</li>
                        )}
                      </ul>
                      {canUploadOutbound ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <input ref={ref} type="file" className="text-[10px] max-w-[11rem]" />
                          <button
                            type="button"
                            className="btn-primary !py-1 !px-2 text-[10px]"
                            disabled={loading}
                            onClick={() => uploadOrderDocFile(stage)}
                          >
                            Upload
                          </button>
                        </div>
                      ) : (
                        <div className="text-[10px] text-gray-500">Upload requires outbound upload permission.</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {(detail.order_documents || []).some((d) => d.upload_stage && !['order_created', 'post_delivery'].includes(d.upload_stage)) ? (
                <div className="mt-2 text-[10px] text-gray-600 border-t border-gray-200 pt-2">
                  <span className="font-semibold">Other tags:</span>{' '}
                  {(detail.order_documents || [])
                    .filter((d) => d.upload_stage && !['order_created', 'post_delivery'].includes(d.upload_stage))
                    .map((d) => (
                      <span key={d.id} className="inline-block mr-2">
                        <button type="button" className="text-primary-700 underline" onClick={() => downloadOrderDoc(d)}>
                          {d.file_name}
                        </button>
                        {canUploadOutbound ? (
                          <button type="button" className="text-red-600 ml-0.5" onClick={() => deleteOrderDoc(d.id)} title="Remove">
                            ×
                          </button>
                        ) : null}
                      </span>
                    ))}
                </div>
              ) : null}
            </div>

            {isAdmin ? (
              <div className="mb-3 rounded-lg border border-blue-100 bg-blue-50 p-3">
                <label className="flex items-center gap-2 text-[11px] font-bold text-blue-900">
                  <input
                    type="checkbox"
                    checked={manualPick.override}
                    onChange={(e) => setManualPick((s) => ({ ...s, override: e.target.checked }))}
                  />
                  Admin override
                </label>
                {manualPick.override ? (
                  <input
                    className="input-field mt-2"
                    placeholder="Override reason"
                    value={manualPick.reason}
                    onChange={(e) => setManualPick((s) => ({ ...s, reason: e.target.value }))}
                  />
                ) : null}
              </div>
            ) : null}

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
                    <SortTh columnKey="material" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Material
                    </SortTh>
                    <SortTh columnKey="sap_part_number" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      SAP PN
                    </SortTh>
                    <SortTh columnKey="description" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Description
                    </SortTh>
                    <SortTh columnKey="required_qty" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Req (editable if shortage)
                    </SortTh>
                    <SortTh columnKey="picked_qty" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Picked
                    </SortTh>
                    <SortTh columnKey="line_remaining_qty" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Remaining
                    </SortTh>
                    <SortTh columnKey="available_qty_main_stock" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Main avail
                    </SortTh>
                    <SortTh columnKey="fifo_status" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      FIFO
                    </SortTh>
                    <SortTh columnKey="shortage_qty" sortKey={itemSortKey} direction={itemDir} onSort={itemRequestSort}>
                      Shortage
                    </SortTh>
                    <th className="tbl-th">Save</th>
                  </tr>
                </thead>
                <tbody>
                  {itemDisplayRows.map((it) => (
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
                      <td className="tbl-td-nowrap">{pickQty(it.picked_qty)}</td>
                      <td className="tbl-td-nowrap">
                        {Math.max(0, pickQty(it.required_qty) - pickQty(it.picked_qty)).toLocaleString()}
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
                    <SortTh columnKey="material" sortKey={fifoSortKey} direction={fifoDir} onSort={fifoRequestSort}>
                      Item
                    </SortTh>
                    <SortTh columnKey="rack_location" sortKey={fifoSortKey} direction={fifoDir} onSort={fifoRequestSort}>
                      Rack
                    </SortTh>
                    <SortTh columnKey="suggested_qty" sortKey={fifoSortKey} direction={fifoDir} onSort={fifoRequestSort}>
                      Suggest qty
                    </SortTh>
                    <SortTh columnKey="fifo_picked_qty" sortKey={fifoSortKey} direction={fifoDir} onSort={fifoRequestSort}>
                      Picked (FIFO)
                    </SortTh>
                    <SortTh columnKey="fifo_remaining_qty" sortKey={fifoSortKey} direction={fifoDir} onSort={fifoRequestSort}>
                      FIFO left
                    </SortTh>
                    <SortTh columnKey="fifo_sequence" sortKey={fifoSortKey} direction={fifoDir} onSort={fifoRequestSort}>
                      Seq
                    </SortTh>
                    <th className="tbl-th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {fifoDisplayRows.map((f) => (
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
                      <td className="tbl-td-nowrap">{pickQty(f.fifo_picked_qty)}</td>
                      <td className="tbl-td-nowrap">
                        {Math.max(0, pickQty(f.suggested_qty) - pickQty(f.fifo_picked_qty)).toLocaleString()}
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
                        <SortTh columnKey="rack_location" sortKey={rackSortKey} direction={rackDir} onSort={rackRequestSort}>
                          Rack
                        </SortTh>
                        <SortTh columnKey="part_number" sortKey={rackSortKey} direction={rackDir} onSort={rackRequestSort}>
                          Part
                        </SortTh>
                        <SortTh columnKey="sap_part_number" sortKey={rackSortKey} direction={rackDir} onSort={rackRequestSort}>
                          SAP
                        </SortTh>
                        <SortTh columnKey="available_qty" sortKey={rackSortKey} direction={rackDir} onSort={rackRequestSort}>
                          Avail
                        </SortTh>
                        <th className="tbl-th">Action</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white">
                      {rackDisplayRows.map((r) => (
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
