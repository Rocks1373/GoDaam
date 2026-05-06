import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { dashboardApi } from '../services/api';
import {
  UploadCloud,
  Truck,
  ClipboardList,
  Package,
  Clock,
  CheckCircle2,
  AlertCircle,
  Bell,
} from 'lucide-react';

function StatCard({ title, value, icon: Icon, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-50 text-slate-800 border-slate-200',
    blue: 'bg-blue-50 text-blue-900 border-blue-200',
    amber: 'bg-amber-50 text-amber-900 border-amber-200',
    green: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    red: 'bg-rose-50 text-rose-900 border-rose-200',
  };
  return (
    <div className={`display-stat-card rounded-lg border ${tones[tone] || tones.slate}`}>
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

export default function Dashboard() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [activity, setActivity] = useState(null);
  const [dn, setDn] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, a, n] = await Promise.all([
        dashboardApi.summary(),
        dashboardApi.recentActivity(),
        dashboardApi.notifications(),
      ]);
      setSummary(s);
      setActivity(a);
      setDn(n);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const fmtAct = (row) => {
    if (!row?.ref && !row?.at) return '—';
    return `${row.ref || '—'} · ${row.at ? String(row.at).replace('T', ' ').slice(0, 19) : ''}`;
  };

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  const s = summary || {};

  return (
    <div className="max-w-[1400px]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-900 leading-tight">Dashboard</h2>
          <p className="text-[11px] text-gray-600">Orders overview — upload runs daily</p>
        </div>
        <button type="button" className="btn-primary flex items-center gap-2 px-4 py-2" onClick={() => navigate('/outbound-upload')}>
          <UploadCloud size={18} />
          Upload Order
        </button>
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

      <div className="display-stat-grid grid grid-cols-1 lg:grid-cols-2 mb-3">
        <div className="display-card bg-white rounded-lg border border-gray-200 shadow-sm text-gray-700">
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

        <div className="display-card bg-white rounded-lg border border-gray-200 shadow-sm text-gray-700">
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
        <button type="button" className="text-primary-700 font-bold hover:underline" onClick={load} disabled={loading}>
          Refresh data
        </button>
      </div>
    </div>
  );
}
