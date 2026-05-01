import { api } from './client';

export async function confirmItem(payload: {
  outbound_order_id: number;
  outbound_item_id: number;
  fifo_suggestion_id: number;
  scanned_rack: string;
  picked_qty: number;
  device_id?: string;
}) {
  const res = await api.post('/mobile/picking/confirm-item', payload);
  return res.data;
}

export async function confirmOrder(outbound_order_id: number) {
  const res = await api.post('/mobile/picking/confirm-order', { outbound_order_id });
  return res.data;
}

export async function requestPickChange(payload: {
  outbound_order_id: number;
  outbound_item_id: number;
  fifo_suggestion_id?: number | null;
  requested_rack_location?: string | null;
  requested_qty?: number | null;
  reason?: string | null;
}) {
  const res = await api.post('/mobile/picking/change-request', payload);
  return res.data;
}
