import { useEffect, useState } from 'react';
import { notificationsApi } from '../services/api';

function safeJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function Notifications() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setMsg('');
    try {
      const data = await notificationsApi.list({ unread_only: false });
      setRows(data || []);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const markRead = async (id) => {
    try {
      await notificationsApi.markRead(id);
      await load();
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Notifications</h2>
        <p className="text-[11px] text-gray-600">Click a row to mark as read</p>
      </div>

      <div className="app-page-toolbar flex items-center gap-2">
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
              <th className="tbl-th">Read</th>
              <th className="tbl-th">Title</th>
              <th className="tbl-th">Body</th>
              <th className="tbl-th">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(rows || []).map((n) => {
              const read = !!n.read_at;
              const data = safeJson(n.data_json);
              return (
                <tr
                  key={n.id}
                  className={`hover:bg-gray-50 cursor-pointer ${read ? '' : 'bg-primary-50/40'}`}
                  title={data ? JSON.stringify(data) : ''}
                  onClick={() => markRead(n.id)}
                >
                  <td className="tbl-td-nowrap">{read ? '✓' : ''}</td>
                  <td className="tbl-td-nowrap font-bold">{n.title}</td>
                  <td className="tbl-td">{n.body}</td>
                  <td className="tbl-td-nowrap">{String(n.created_at || '').slice(0, 19).replace('T', ' ')}</td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={4}>
                  No notifications.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

