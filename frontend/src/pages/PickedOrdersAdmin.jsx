import { useEffect, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { pickedOrdersApi } from '../services/api';

export default function PickedOrdersAdmin() {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const navigate = useNavigate();

  const load = async () => {
    try {
      setRows(await pickedOrdersApi.list({}));
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openDetail = async (id) => {
    try {
      setDetail(await pickedOrdersApi.get(id));
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900">Picked orders</h2>
        <p className="text-[11px] text-gray-600">Admin only · audit trail</p>
      </div>

      <div className="table-container">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="tbl-th">ID</th>
              <th className="tbl-th">Delivery</th>
              <th className="tbl-th">Sales Doc.</th>
              <th className="tbl-th">Customer Ref.</th>
              <th className="tbl-th">Customer name</th>
              <th className="tbl-th">Confirmed by</th>
              <th className="tbl-th">At</th>
              <th className="tbl-th"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{r.id}</td>
                <td className="tbl-td-nowrap">{r.delivery}</td>
                <td className="tbl-td-nowrap">{r.sales_doc}</td>
                <td className="tbl-td-nowrap">{r.customer_reference || '-'}</td>
                <td className="tbl-td">{r.customer_name || '-'}</td>
                <td className="tbl-td">{r.confirmed_by_user_name}</td>
                <td className="tbl-td-nowrap">{String(r.confirmed_at || '').slice(0, 19)}</td>
                <td className="tbl-td-nowrap">
                  <button
                    type="button"
                    className="btn-secondary !py-1 !px-1.5 mr-1"
                    title="Create DN"
                    onClick={() => navigate(`/delivery-note?outbound=${encodeURIComponent(r.delivery || '')}`)}
                  >
                    <FileText size={14} />
                  </button>
                  <button type="button" className="btn-secondary !py-1 !px-1.5" onClick={() => openDetail(r.id)}>
                    <Eye size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-xl p-5 w-full max-w-3xl max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between mb-3">
              <div className="font-bold text-sm">Picked order #{detail.id}</div>
              <button type="button" className="btn-secondary" onClick={() => setDetail(null)}>
                Close
              </button>
            </div>
            <div className="text-[11px] space-y-1 mb-4">
              <div>Outbound ID: {detail.outbound_order_id}</div>
              <div>Delivery: {detail.delivery}</div>
              <div>Sales Doc.: {detail.sales_doc}</div>
            </div>
            <div className="text-[10px] font-bold uppercase text-gray-600 mb-1">Transactions</div>
            <table className="min-w-full text-[11px] border">
              <thead className="bg-gray-50">
                <tr>
                  <th className="tbl-th">User</th>
                  <th className="tbl-th">Part</th>
                  <th className="tbl-th">Rack</th>
                  <th className="tbl-th">Qty</th>
                  <th className="tbl-th">When</th>
                </tr>
              </thead>
              <tbody>
                {(detail.transactions || []).map((t) => (
                  <tr key={t.id}>
                    <td className="tbl-td">{t.user_name}</td>
                    <td className="tbl-td">{t.sap_part_number || t.material}</td>
                    <td className="tbl-td">{t.rack_location}</td>
                    <td className="tbl-td">{t.picked_qty}</td>
                    <td className="tbl-td-nowrap">{String(t.picked_at || '').slice(0, 19)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
