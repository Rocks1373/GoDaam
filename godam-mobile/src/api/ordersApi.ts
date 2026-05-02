import { api } from './client';

export type StockOverviewLine = {
  outbound_item_id: number;
  material?: string | null;
  part_number: string;
  sap_part_number?: string;
  description?: string | null;
  required_qty: number;
  picked_qty: number;
  picked_qty_effective: number;
  remaining_qty: number;
  vendor_number?: string | null;
  vendor_name?: string | null;
  main_stock?: {
    available_qty?: number;
    received_qty?: number;
    sold_out_qty?: number;
    pending_delivery_qty?: number;
    uom?: string | null;
    remarks?: string | null;
  } | null;
  racks: Record<string, unknown>[];
};

export type StockOverviewResponse = {
  order_id: number;
  rack_q: string | null;
  lines: StockOverviewLine[];
};

export type MobileSummary = {
  notifications_unread: number;
  orders_unseen: number;
  /** Inbound batches that still have remaining qty to put away */
  inbound_putaway_pending: number;
};

export async function getMobileSummary() {
  const res = await api.get<MobileSummary>('/mobile/summary');
  return res.data;
}

export async function markOrderSeen(orderId: number) {
  await api.post(`/mobile/orders/${orderId}/seen`);
}

export async function listOrders() {
  const res = await api.get('/mobile/orders');
  return res.data as Record<string, unknown>[];
}

export async function getOrder(id: number) {
  const res = await api.get(`/mobile/orders/${id}`);
  return res.data as Record<string, unknown>;
}

/** Main stock + rack rows for each pick line (optional rack location substring filter). */
export async function getOrderStockOverview(orderId: number, rackQ?: string) {
  const params = rackQ?.trim() ? { rack_q: rackQ.trim() } : {};
  const res = await api.get(`/mobile/orders/${orderId}/stock-overview`, { params });
  return res.data as StockOverviewResponse;
}
