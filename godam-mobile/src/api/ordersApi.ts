import { api } from './client';

export async function listOrders() {
  const res = await api.get('/mobile/orders');
  return res.data as Record<string, unknown>[];
}

export async function getOrder(id: number) {
  const res = await api.get(`/mobile/orders/${id}`);
  return res.data as Record<string, unknown>;
}
