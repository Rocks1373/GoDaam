import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, deliveryNotesApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

function safeJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function Notifications() {
  const navigate = useNavigate();
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

  const notifSort = useCallback((n, k) => {
    if (k === 'read_flag') return n.read_at ? 1 : 0;
    if (k === 'created_at') {
      const t = n.created_at ? new Date(n.created_at).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return n[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, notifSort);

  const markRead = async (id) => {
    try {
      await notificationsApi.markRead(id);
      await load();
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    }
  };

  const openPodFile = async (e, dnId) => {
    e.stopPropagation();
    if (!dnId) return;
    try {
      const blob = await deliveryNotesApi.downloadPod(dnId);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (err) {
      setMsg(err?.response?.data?.error || err.message);
    }
  };

  const openDeliveryNote = (e, outbound) => {
    e.stopPropagation();
    if (!outbound) return;
    navigate(`/delivery-note?outbound=${encodeURIComponent(outbound)}`);
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Notifications</h2>
        <p className="text-[11px] text-gray-600">
          Click a row to mark as read. Delivery alerts may include <strong>View POD</strong> / <strong>Open DN</strong> when a
          proof file is available.
        </p>
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
              <SortTh columnKey="read_flag" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Read
              </SortTh>
              <SortTh columnKey="title" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Title
              </SortTh>
              <SortTh columnKey="body" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Body
              </SortTh>
              <SortTh columnKey="created_at" sortKey={sortKey} direction={direction} onSort={requestSort}>
                When
              </SortTh>
              <th className="tbl-th text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(displayRows || []).map((n) => {
              const read = !!n.read_at;
              const data = safeJson(n.data_json);
              const dnId = data?.dn_id;
              const outbound = data?.outbound_number;
              const isPod = data?.type === 'pod_uploaded' || /POD/i.test(n.title || '');
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
                  <td className="tbl-td" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap gap-1">
                      {dnId && isPod ? (
                        <button
                          type="button"
                          className="btn-secondary text-[10px] py-0.5 px-1.5"
                          onClick={(e) => openPodFile(e, dnId)}
                        >
                          View POD
                        </button>
                      ) : null}
                      {outbound ? (
                        <button
                          type="button"
                          className="btn-secondary text-[10px] py-0.5 px-1.5"
                          onClick={(e) => openDeliveryNote(e, outbound)}
                        >
                          {isPod ? 'Open DN (POD)' : 'Open DN'}
                        </button>
                      ) : null}
                      {!dnId && !outbound ? <span className="text-[10px] text-gray-400">—</span> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={5}>
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

