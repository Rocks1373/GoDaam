import { useCallback, useEffect, useState } from 'react';
import { Eye, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { pickedOrdersApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

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

  const pickedListSort = useCallback((r, k) => {
    if (k === 'id') return Number(r.id) || 0;
    if (k === 'confirmed_at') {
      const t = r.confirmed_at ? new Date(r.confirmed_at).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return r[k];
  }, []);

  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, pickedListSort);

  const txSort = useCallback((t, k) => {
    if (k === 'picked_qty') return Number(t.picked_qty) || 0;
    if (k === 'picked_at') {
      const x = t.picked_at ? new Date(t.picked_at).getTime() : 0;
      return Number.isFinite(x) ? x : 0;
    }
    if (k === 'part') return t.sap_part_number || t.material || '';
    return t[k];
  }, []);

  const {
    displayRows: txDisplayRows,
    sortKey: txSortKey,
    direction: txDirection,
    requestSort: txRequestSort,
  } = useTableSort(detail?.transactions, txSort);

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
              <SortTh columnKey="id" sortKey={sortKey} direction={direction} onSort={requestSort}>
                ID
              </SortTh>
              <SortTh columnKey="delivery" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Delivery
              </SortTh>
              <SortTh columnKey="sales_doc" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Sales Doc.
              </SortTh>
              <SortTh columnKey="customer_reference" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Customer Ref.
              </SortTh>
              <SortTh columnKey="customer_name" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Customer name
              </SortTh>
              <SortTh columnKey="confirmed_by_user_name" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Confirmed by
              </SortTh>
              <SortTh columnKey="confirmed_at" sortKey={sortKey} direction={direction} onSort={requestSort}>
                At
              </SortTh>
              <th className="tbl-th"> </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {displayRows.map((r) => (
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
                  <SortTh columnKey="user_name" sortKey={txSortKey} direction={txDirection} onSort={txRequestSort}>
                    User
                  </SortTh>
                  <SortTh columnKey="part" sortKey={txSortKey} direction={txDirection} onSort={txRequestSort}>
                    Part
                  </SortTh>
                  <SortTh columnKey="rack_location" sortKey={txSortKey} direction={txDirection} onSort={txRequestSort}>
                    Rack
                  </SortTh>
                  <SortTh columnKey="picked_qty" sortKey={txSortKey} direction={txDirection} onSort={txRequestSort}>
                    Qty
                  </SortTh>
                  <SortTh columnKey="picked_at" sortKey={txSortKey} direction={txDirection} onSort={txRequestSort}>
                    When
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {txDisplayRows.map((t) => (
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
