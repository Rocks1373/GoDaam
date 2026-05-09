import { api } from './client';

export type PickedOrderRow = {
  order_id: number;
  delivery?: string | null;
  sales_doc?: string | null;
  customer_reference?: string | null;
  sold_to?: string | null;
  name_1?: string | null;
  confirmed_by_user_id?: number | null;
  confirmed_by_user_name?: string | null;
  confirmed_at?: string | null;
  order_status?: string | null;
  order_updated_at?: string | null;
  picked_by_names?: string | null;
};

export type PickedTransactionRow = {
  id: number;
  user_id: number;
  user_name?: string | null;
  material?: string | null;
  sap_part_number?: string | null;
  description?: string | null;
  rack_location?: string | null;
  picked_qty: number;
  picked_at?: string | null;
};

export async function listPickedOrders(limit = 120) {
  const res = await api.get<PickedOrderRow[]>('/mobile/picked-orders', { params: { limit } });
  return res.data;
}

export async function getPickedOrderDetail(orderId: number) {
  const res = await api.get<{ picked_order: Record<string, unknown>; order: Record<string, unknown>; picked_transactions: PickedTransactionRow[] }>(
    `/mobile/picked-orders/${orderId}`
  );
  return res.data;
}

