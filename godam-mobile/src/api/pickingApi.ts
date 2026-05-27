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

/** When FIFO has no remaining lines for this order line — pick up to full remaining from one rack. */
export async function confirmItemFromRack(payload: {
  outbound_order_id: number;
  outbound_item_id: number;
  stock_by_rack_id: number;
  scanned_rack: string;
  picked_qty?: number;
  outbound_bom_requirement_id?: number | null;
  device_id?: string;
}) {
  const res = await api.post('/mobile/picking/confirm-item-from-rack', payload);
  return res.data;
}

/** Full remaining qty for the line — creates/uses stock_by_rack at typed location, then deducts + stock_out. */
export async function confirmItemWithNewRack(payload: {
  outbound_order_id: number;
  outbound_item_id: number;
  rack_location: string;
  picked_qty: number;
  outbound_bom_requirement_id?: number | null;
  device_id?: string;
}) {
  const res = await api.post('/mobile/picking/confirm-item-with-new-rack', payload);
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

export type ItemPickTransaction = {
  id: number;
  outbound_order_id: number;
  outbound_item_id: number;
  outbound_bom_requirement_id?: number | null;
  rack_location?: string | null;
  material?: string | null;
  sap_part_number?: string | null;
  picked_qty?: number | null;
  user_name?: string | null;
  picked_method?: string | null;
  is_bom_pick?: number | null;
};

/** List picks saved for one order line while order is Sent For Pick / Picking (for Adjust tab). */
export async function listItemPickTransactions(payload: {
  outbound_item_id: number;
  outbound_order_id: number;
  outbound_bom_requirement_id?: number | null;
}) {
  const res = await api.get(`/mobile/picking/${payload.outbound_item_id}/item-pick-transactions`, {
    params: {
      outbound_order_id: payload.outbound_order_id,
      ...(payload.outbound_bom_requirement_id != null && payload.outbound_bom_requirement_id > 0
        ? { outbound_bom_requirement_id: payload.outbound_bom_requirement_id }
        : {}),
    },
  });
  return (res.data?.transactions || []) as ItemPickTransaction[];
}

/** Undo pick row(s): restores rack qty and lowers line picked qty. Only while order not confirmed picked. */
export async function reverseItemPicks(payload: {
  outbound_order_id: number;
  outbound_item_id: number;
  picked_transaction_ids: number[];
  reason?: string | null;
}) {
  const res = await api.post('/mobile/picking/reverse-item-picks', payload);
  return res.data as { ok: boolean; removed: number; restored_rack_qty: number };
}
