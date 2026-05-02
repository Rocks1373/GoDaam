import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deliveryNotesApi } from '../services/api';
import { Image as ImageIcon } from 'lucide-react';

export default function PodInbox() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const data = await deliveryNotesApi.recentPods({ limit: 80 });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const viewPod = async (dnId) => {
    try {
      const blob = await deliveryNotesApi.downloadPod(dnId);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900 leading-tight flex items-center gap-2">
            <ImageIcon className="w-4 h-4" />
            POD inbox
          </h2>
          <p className="text-[11px] text-gray-600 mt-0.5">
            Proof-of-delivery files uploaded by drivers (stored on the delivery note). Newest first.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {msg ? <div className="mt-2 text-[11px] text-red-700">{msg}</div> : null}
      {loading ? <div className="text-[11px] text-gray-500 mt-2">Loading…</div> : null}

      <div className="table-container mt-3">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="tbl-th text-left">Outbound</th>
              <th className="tbl-th text-left">Customer</th>
              <th className="tbl-th text-left">Invoice</th>
              <th className="tbl-th text-left">Uploaded</th>
              <th className="tbl-th text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(rows || []).map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="tbl-td font-semibold">{r.outbound_number || '—'}</td>
                <td className="tbl-td">{r.customer_name || '—'}</td>
                <td className="tbl-td">{r.invoice_number || '—'}</td>
                <td className="tbl-td-nowrap">{String(r.pod_uploaded_at || '').slice(0, 19).replace('T', ' ') || '—'}</td>
                <td className="tbl-td">
                  <div className="flex flex-wrap gap-1">
                    <button type="button" className="btn-secondary text-[11px] py-0.5 px-2" onClick={() => viewPod(r.id)}>
                      View POD
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-[11px] py-0.5 px-2"
                      onClick={() =>
                        navigate(`/delivery-note?outbound=${encodeURIComponent(r.outbound_number || '')}`)
                      }
                    >
                      Open DN
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && !loading ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={5}>
                  No POD files yet. They appear here when a driver uploads proof on a delivery task.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
