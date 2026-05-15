import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { dashboardApi, outboundGodamApi } from '../services/api';
import { downloadUploadErrorWorkbook, uploadSummary } from '../utils/uploadErrorReport';
import {
  UploadCloud,
  Truck,
  ClipboardList,
  Package,
  Clock,
  CheckCircle2,
  AlertCircle,
  Bell,
  FileText,
  CalendarRange,
} from 'lucide-react';

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, delta) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoToday();
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Light row + badge tones for outbound lifecycle (picked vs under-pick vs delivered). */
function outboundStatusVisual(statusRaw) {
  const s = String(statusRaw || '').trim().toLowerCase();
  if (s.includes('cancel')) {
    return {
      row: 'bg-rose-50/95 border-l-[5px] border-rose-400',
      chip: 'inline-flex rounded px-1.5 py-0.5 text-[10px] font-extrabold bg-rose-100 text-rose-900',
    };
  }
  if (s === 'delivered') {
    return {
      row: 'bg-emerald-50/95 border-l-[5px] border-emerald-400',
      chip: 'inline-flex rounded px-1.5 py-0.5 text-[10px] font-extrabold bg-emerald-100 text-emerald-900',
    };
  }
  if (s === 'picked') {
    return {
      row: 'bg-sky-50/95 border-l-[5px] border-sky-500',
      chip: 'inline-flex rounded px-1.5 py-0.5 text-[10px] font-extrabold bg-sky-100 text-sky-950',
    };
  }
  if (s === 'sent for pick' || s === 'picking') {
    return {
      row: 'bg-amber-50/95 border-l-[5px] border-amber-400',
      chip: 'inline-flex rounded px-1.5 py-0.5 text-[10px] font-extrabold bg-amber-100 text-amber-950',
    };
  }
  return {
    row: 'bg-slate-50/90 border-l-[5px] border-slate-300',
    chip: 'inline-flex rounded px-1.5 py-0.5 text-[10px] font-extrabold bg-slate-100 text-slate-800',
  };
}

function fmtDateTimeShort(v) {
  if (!v) return '—';
  return String(v).replace('T', ' ').slice(0, 19);
}

function StatCard({ title, value, icon: Icon, tone = 'slate' }) {
  const tones = {
    slate: 'stat-tone-slate',
    blue: 'stat-tone-primary',
    primary: 'stat-tone-primary',
    amber: 'stat-tone-amber',
    green: 'stat-tone-green',
    red: 'stat-tone-red',
  };
  return (
    <div className={`display-stat-card ${tones[tone] || tones.slate}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="ds-title font-bold uppercase tracking-wide opacity-80">{title}</p>
          <p className="ds-value font-extrabold mt-0.5">{value}</p>
        </div>
        {Icon ? <Icon className="ds-icon flex-shrink-0 opacity-80" /> : null}
      </div>
    </div>
  );
}

const UPLOAD_ACCEPT = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/excel',
  'text/csv',
]);

function isSpreadsheetFile(file) {
  if (!file || !file.name) return false;
  const lower = String(file.name).toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) return true;
  return UPLOAD_ACCEPT.has(String(file.type || '').toLowerCase());
}

export default function Dashboard({ currentUser }) {
  const navigate = useNavigate();
  const dashUploadRef = useRef(null);
  const dashDragDepth = useRef(0);
  const [summary, setSummary] = useState(null);
  const [activity, setActivity] = useState(null);
  const [dn, setDn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dashUploadBusy, setDashUploadBusy] = useState(false);
  const [dashDropActive, setDashDropActive] = useState(false);

  const [rangeFrom, setRangeFrom] = useState(() => addDays(isoToday(), -6));
  const [rangeTo, setRangeTo] = useState(isoToday);
  const [rangeData, setRangeData] = useState(null);
  const [rangeLoading, setRangeLoading] = useState(false);
  const [pipeline, setPipeline] = useState(null);

  const loadCore = async () => {
    setLoading(true);
    try {
      const [s, a, n, pl] = await Promise.all([
        dashboardApi.summary(),
        dashboardApi.recentActivity(),
        dashboardApi.notifications(),
        dashboardApi.orderPipeline().catch(() => null),
      ]);
      setSummary(s);
      setActivity(a);
      setDn(n);
      setPipeline(pl);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadRange = useCallback(async () => {
    setRangeLoading(true);
    try {
      const r = await dashboardApi.rangeSummary({ from: rangeFrom, to: rangeTo });
      setRangeData(r);
    } catch (e) {
      console.error(e);
      setRangeData(null);
    } finally {
      setRangeLoading(false);
    }
  }, [rangeFrom, rangeTo]);

  useEffect(() => {
    loadCore();
  }, []);

  useEffect(() => {
    loadRange();
  }, [loadRange]);

  const canUploadOutbound =
    String(currentUser?.role || '').toLowerCase() === 'admin' || Boolean(currentUser?.permissions?.can_upload_outbound);

  const refreshAfterUpload = useCallback(async () => {
    await loadCore();
    await loadRange();
  }, [loadRange]);

  const runOutboundUpload = async (file) => {
    if (!canUploadOutbound) {
      toast.error('You do not have permission to upload outbound orders.');
      return;
    }
    if (!isSpreadsheetFile(file)) {
      toast.error('Please drop an Excel or CSV file (.xlsx, .xls, .csv).');
      return;
    }
    setDashUploadBusy(true);
    try {
      const res = await outboundGodamApi.uploadExcel(file);
      const { failed, total, success } = uploadSummary(res);
      if (failed.length) downloadUploadErrorWorkbook({ data: res, filenamePrefix: 'outbound-upload' });
      const message = failed.length
        ? `Imported ${success} of ${total} outbound(s). ${failed.length} failed; error Excel downloaded.`
        : success
          ? `Imported ${success} outbound order(s).`
          : 'Upload completed.';
      toast[failed.length ? 'warning' : 'success'](message, {
        action: {
          label: 'Review on upload page',
          onClick: () => navigate('/outbound-pick'),
        },
      });
      await refreshAfterUpload();
    } catch (e) {
      const failed = downloadUploadErrorWorkbook({ data: e.response?.data, filenamePrefix: 'outbound-upload' });
      if (failed) {
        toast.error(`Upload failed. Downloaded an error Excel with ${failed} row(s).`);
      } else {
      toast.error(e.response?.data?.error || e.message || 'Upload failed');
      }
    } finally {
      setDashUploadBusy(false);
      if (dashUploadRef.current) dashUploadRef.current.value = '';
    }
  };

  const fmtAct = (row) => {
    if (!row?.ref && !row?.at) return '—';
    return `${row.ref || '—'} · ${row.at ? String(row.at).replace('T', ' ').slice(0, 19) : ''}`;
  };

  const presetToday = () => {
    const t = isoToday();
    setRangeFrom(t);
    setRangeTo(t);
  };
  const presetYesterday = () => {
    const y = addDays(isoToday(), -1);
    setRangeFrom(y);
    setRangeTo(y);
  };
  const presetWeek = () => {
    setRangeFrom(addDays(isoToday(), -6));
    setRangeTo(isoToday());
  };

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-theme-border border-t-theme-primary" />
      </div>
    );
  }

  const s = summary || {};

  return (
    <div className="max-w-[1400px]">
      <header className="app-page-header">
        <div>
          <h2 className="app-page-header__title">Dashboard</h2>
          <p className="app-page-header__subtitle">Orders overview — upload runs daily</p>
        </div>
        <div className="app-page-header__actions">
          <NavLink to="/delivery-note" className="btn-primary flex items-center gap-2 px-4 py-2">
            <FileText size={18} />
            Create DN
          </NavLink>
          <button type="button" className="btn-primary flex items-center gap-2 px-4 py-2" onClick={() => navigate('/outbound-pick')}>
            <UploadCloud size={18} />
            Upload Order
          </button>
        </div>
      </header>

      {canUploadOutbound ? (
        <div className="mb-3">
          <input
            ref={dashUploadRef}
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void runOutboundUpload(f);
            }}
          />
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dashUploadRef.current?.click();
              }
            }}
            onClick={() => !dashUploadBusy && dashUploadRef.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dashDragDepth.current += 1;
              setDashDropActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dashDragDepth.current = Math.max(0, dashDragDepth.current - 1);
              if (dashDragDepth.current === 0) setDashDropActive(false);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dashDragDepth.current = 0;
              setDashDropActive(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) void runOutboundUpload(f);
            }}
            className={[
              'app-upload-dropzone',
              dashDropActive ? 'app-upload-dropzone--active' : '',
              dashUploadBusy ? 'app-upload-dropzone--disabled' : '',
            ].join(' ')}
          >
            <UploadCloud className="w-10 h-10 mx-auto mb-2 text-[var(--color-primary)] opacity-90" aria-hidden />
            <p className="text-sm font-bold text-theme-fg">
              {dashUploadBusy ? 'Uploading…' : 'Drag & drop outbound order file here'}
            </p>
            <p className="text-[11px] text-theme-fg-muted mt-1 max-w-lg mx-auto">
              Same upload as <span className="font-semibold">Upload Order</span> — Excel (.xlsx, .xls) or CSV. After import, stats and tables below refresh automatically. Use{' '}
              <button
                type="button"
                className="text-theme-primary font-bold underline"
                onClick={(ev) => {
                  ev.stopPropagation();
                  navigate('/outbound-pick');
                }}
              >
                full upload page
              </button>{' '}
              for stock check, FIFO, and pick workflow.
            </p>
          </div>
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-amber-100 bg-amber-50/90 px-3 py-2 text-[11px] text-amber-950">
          Outbound drag-and-drop upload is available to users with <strong>upload outbound</strong> permission.
        </div>
      )}

      <div className="display-card app-panel mb-3">
        <h3 className="dc-head font-bold text-theme-fg flex items-center gap-2 flex-wrap">
          <CalendarRange className="dc-ic flex-shrink-0" />
          Activity by date range
          <span className="text-[10px] font-semibold text-theme-fg-muted normal-case tracking-normal">
            (default last 7 days — adjust dates to compare yesterday or any span)
          </span>
        </h3>
        <div className="dc-body flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] font-bold text-gray-700">
              From
              <input type="date" className="input-field mt-1 block" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
            </label>
            <label className="text-[11px] font-bold text-gray-700">
              To
              <input type="date" className="input-field mt-1 block" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
            </label>
            <button type="button" className="btn-secondary text-[11px] mt-5" onClick={presetWeek}>
              Last 7 days
            </button>
            <button type="button" className="btn-secondary text-[11px] mt-5" onClick={presetToday}>
              Today
            </button>
            <button type="button" className="btn-secondary text-[11px] mt-5" onClick={presetYesterday}>
              Yesterday
            </button>
            <button type="button" className="btn-secondary text-[11px] mt-5" onClick={() => loadRange()} disabled={rangeLoading}>
              {rangeLoading ? 'Loading…' : 'Apply'}
            </button>
          </div>

          {(rangeData?.dn_status_in_range || []).length ? (
            <div>
              <div className="text-[11px] font-bold text-gray-800 mb-1">Delivery notes in range (by status)</div>
              <ul className="text-[11px] text-gray-700 space-y-0.5">
                {(rangeData.dn_status_in_range || []).map((x) => (
                  <li key={x.status}>
                    <span className="font-semibold">{x.status}:</span> {x.count}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="display-stat-grid grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 mb-3">
        <StatCard title="Total Orders Uploaded" value={s.total_orders_uploaded ?? '—'} icon={Package} tone="slate" />
        <StatCard title="Orders Pending" value={s.orders_pending ?? '—'} icon={Clock} tone="amber" />
        <StatCard title="Under Picking" value={s.orders_under_picking ?? '—'} icon={Truck} tone="blue" />
        <StatCard title="Orders Picked" value={s.orders_picked ?? '—'} icon={ClipboardList} tone="blue" />
        <StatCard title="Orders Delivered" value={s.orders_delivered ?? '—'} icon={CheckCircle2} tone="green" />
        <StatCard title="Orders Cancelled" value={s.orders_cancelled ?? '—'} icon={AlertCircle} tone="red" />
        <StatCard title="Today Uploaded" value={s.today_uploaded_orders ?? '—'} icon={UploadCloud} tone="slate" />
        <StatCard title="Today Delivered" value={s.today_delivered_orders ?? '—'} icon={CheckCircle2} tone="green" />
      </div>

      <div className="display-card app-panel mb-3">
        <h3 className="dc-head font-bold text-gray-900 flex items-center gap-2 flex-wrap">
          <Package className="dc-ic flex-shrink-0" />
          Outbound &amp; inbound pipeline
          <span className="text-[10px] font-semibold text-gray-500 normal-case tracking-normal">
            Latest outbound rows · color by status (amber = sent for pick / picking, sky = picked, emerald = delivered)
          </span>
        </h3>
        <div className="dc-body space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-violet-50/80 border border-violet-100 px-3 py-2 text-[11px]">
            <span className="font-bold text-violet-950">Inbound putaway pending</span>
            <span className="font-extrabold text-violet-900 tabular-nums">
              {pipeline?.inbound_putaway_pending ?? '—'} batch(es) with open lines
            </span>
            <NavLink to="/reports/inbound" className="text-primary-700 font-bold hover:underline shrink-0">
              Inbound report
            </NavLink>
          </div>
          <div className="overflow-x-auto border border-gray-100 rounded-lg">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left p-2 font-bold">Outbound #</th>
                  <th className="text-left p-2 font-bold">Vendor / sold-to</th>
                  <th className="text-left p-2 font-bold">SO / ref</th>
                  <th className="text-left p-2 font-bold">Customer</th>
                  <th className="text-left p-2 font-bold">Status</th>
                  <th className="text-left p-2 font-bold">Updated</th>
                  <th className="text-left p-2 font-bold">Open</th>
                </tr>
              </thead>
              <tbody>
                {(pipeline?.outbound_orders || []).length ? (
                  (pipeline.outbound_orders || []).map((r) => {
                    const pick = outboundStatusVisual(r.status);
                    const ob = String(r.outbound_number || '').trim();
                    const vendor = String(r.vendor_name || r.sold_to || '—').trim() || '—';
                    const ref = String(
                      r.sales_order_number || r.sales_doc || r.customer_po_number || r.reference_no || ''
                    ).trim() || '—';
                    const cust = String(r.customer_name || r.name_1 || '—').trim() || '—';
                    const st = String(r.status || '').trim() || '—';
                    const stLower = st.toLowerCase();
                    const hrefHub = stLower === 'delivered' ? '/outbound-pick?tab=delivered' : '/outbound-pick';
                    const hrefDn = ob ? `/delivery-note?outbound=${encodeURIComponent(ob)}` : '/delivery-note';
                    return (
                      <tr key={r.id} className={`border-b border-gray-100 ${pick.row}`}>
                        <td className="p-2 font-mono font-bold">{ob || '—'}</td>
                        <td className="p-2 max-w-[160px] truncate" title={vendor}>
                          {vendor}
                        </td>
                        <td className="p-2 max-w-[140px] truncate" title={ref}>
                          {ref}
                        </td>
                        <td className="p-2 max-w-[180px] truncate" title={cust}>
                          {cust}
                        </td>
                        <td className="p-2">
                          <span className={pick.chip}>{st}</span>
                        </td>
                        <td className="p-2 whitespace-nowrap text-gray-600">{fmtDateTimeShort(r.updated_at || r.created_at)}</td>
                        <td className="p-2 whitespace-nowrap">
                          <NavLink to={hrefDn} className="text-primary-700 font-bold hover:underline mr-2">
                            DN
                          </NavLink>
                          <NavLink to={hrefHub} className="text-primary-700 font-bold hover:underline">
                            Outbound &amp; pick
                          </NavLink>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="p-3 text-gray-500" colSpan={7}>
                      No outbound orders loaded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="display-stat-grid grid grid-cols-1 lg:grid-cols-2 mb-3">
        <div className="display-card app-panel">
          <h3 className="dc-head font-bold text-gray-900 flex items-center gap-1">
            <ClipboardList className="dc-ic flex-shrink-0" /> Order activity (latest)
          </h3>
          <ul className="dc-body space-y-0">
            <li>
              <span className="font-semibold text-gray-900">Last uploaded:</span> {fmtAct(activity?.last_uploaded_order)}
            </li>
            <li>
              <span className="font-semibold text-gray-900">Last sent for pick:</span> {fmtAct(activity?.last_sent_for_pick)}
            </li>
            <li>
              <span className="font-semibold text-gray-900">Last picked:</span> {fmtAct(activity?.last_picked_order)}
            </li>
            <li>
              <span className="font-semibold text-gray-900">Last delivered:</span> {fmtAct(activity?.last_delivered_order)}
            </li>
          </ul>
        </div>

        <div className="display-card app-panel">
          <h3 className="dc-head font-bold text-gray-900 flex items-center gap-1">
            <Bell className="dc-ic flex-shrink-0" /> Notifications summary (today)
          </h3>
          <ul className="dc-body space-y-0">
            <li>
              <span className="font-semibold">Order uploaded:</span> {dn?.order_uploaded?.today_count ?? 0}
            </li>
            <li>
              <span className="font-semibold">Order sent for pick:</span> {dn?.order_sent_for_pick?.today_count ?? 0}
            </li>
            <li>
              <span className="font-semibold">Order picked:</span> {dn?.order_picked?.today_count ?? 0}
            </li>
            <li>
              <span className="font-semibold">Order delivered:</span> {dn?.order_delivered?.today_count ?? 0}
            </li>
            <li>
              <span className="font-semibold">Driver / POD (DN delivered today):</span> {dn?.driver_pod_uploaded?.today_count ?? 0}
            </li>
            {dn?.driver_pod_uploaded?.note ? (
              <li className="opacity-80 text-gray-500">Note: {dn.driver_pod_uploaded.note}</li>
            ) : null}
          </ul>
        </div>
      </div>

      <div className="text-[10px] text-gray-500">
        <button type="button" className="text-primary-700 font-bold hover:underline" onClick={loadCore} disabled={loading}>
          Refresh snapshot
        </button>
      </div>
    </div>
  );
}
