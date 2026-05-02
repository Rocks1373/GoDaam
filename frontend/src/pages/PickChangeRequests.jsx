import { useEffect, useState } from 'react';
import api from '../services/api';

export default function PickChangeRequests() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('Pending');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setMsg('');
    try {
      const res = await api.get('/pick-change-requests', { params: { status } });
      setRows(res.data || []);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const resolve = async (id, next) => {
    setLoading(true);
    setMsg('');
    try {
      await api.post(`/pick-change-requests/${id}/resolve`, { status: next });
      await load();
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Pick change requests</h2>
        <p className="text-[11px] text-gray-600">Requests from pickers to change rack/qty</p>
      </div>

      <div className="app-page-toolbar flex flex-wrap items-end gap-2">
        <div>
          <label className="text-[10px] font-bold text-gray-600">Status</label>
          <select className="input-field mt-0.5" value={status} onChange={(e) => setStatus(e.target.value)}>
            {['Pending', 'Approved', 'Rejected', ''].map((s) => (
              <option key={s || 'all'} value={s}>
                {s || 'All'}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
          Refresh
        </button>
        {loading ? <span className="text-[11px] text-gray-500">Working…</span> : null}
      </div>

      {msg ? <div className="mt-2 text-[11px] text-gray-700">{msg}</div> : null}

      <div className="table-container mt-3">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="tbl-th">ID</th>
              <th className="tbl-th">Outbound</th>
              <th className="tbl-th">Item</th>
              <th className="tbl-th">Requested</th>
              <th className="tbl-th">Reason</th>
              <th className="tbl-th">By</th>
              <th className="tbl-th">Status</th>
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{r.id}</td>
                <td className="tbl-td-nowrap">
                  {r.delivery || r.outbound_order_id} {r.sales_doc ? `· ${r.sales_doc}` : ''}
                </td>
                <td className="tbl-td-nowrap">{r.material || r.part_number || r.outbound_item_id}</td>
                <td className="tbl-td-nowrap">
                  Rack {r.requested_rack_location || '-'} · Qty {r.requested_qty ?? '-'}
                </td>
                <td className="tbl-td">{r.reason || '-'}</td>
                <td className="tbl-td-nowrap">{r.requested_by_user_name || r.requested_by_user_id}</td>
                <td className="tbl-td-nowrap">{r.status}</td>
                <td className="tbl-td-nowrap">
                  {r.status === 'Pending' ? (
                    <div className="flex gap-1">
                      <button type="button" className="btn-primary !py-1 !px-2" onClick={() => resolve(r.id, 'Approved')} disabled={loading}>
                        Approve
                      </button>
                      <button type="button" className="btn-secondary !py-1 !px-2" onClick={() => resolve(r.id, 'Rejected')} disabled={loading}>
                        Reject
                      </button>
                    </div>
                  ) : (
                    <span className="text-[11px] text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={8}>
                  No requests.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

