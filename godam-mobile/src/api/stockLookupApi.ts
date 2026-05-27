import { api } from './client';

export type MainStockRow = Record<string, unknown>;
export type StockByRackRow = Record<string, unknown>;

export type MainStockSuggestRow = {
  part_number: string;
  sap_part_number?: string | null;
  description?: string | null;
  uom?: string | null;
};

export type StockByRackPartSuggestRow = MainStockSuggestRow;

export type StockByRackRackSuggestRow = { rack_location: string };

export async function suggestMainStockForMobile(q: string, limit = 400) {
  const qq = q.trim();
  if (!qq) return [] as MainStockSuggestRow[];
  const res = await api.get<MainStockSuggestRow[]>('/mobile/stock/main/suggest', {
    params: { q: qq, limit },
  });
  return Array.isArray(res.data) ? res.data : [];
}

export async function suggestStockByRackPartForMobile(q: string, limit = 400) {
  const qq = q.trim();
  if (!qq) return [] as StockByRackPartSuggestRow[];
  const res = await api.get<StockByRackPartSuggestRow[]>('/mobile/stock/by-rack/suggest', {
    params: { type: 'part', q: qq, limit },
  });
  return Array.isArray(res.data) ? res.data : [];
}

export async function suggestStockByRackRackForMobile(q: string, limit = 400) {
  const qq = q.trim();
  if (!qq) return [] as StockByRackRackSuggestRow[];
  const res = await api.get<StockByRackRackSuggestRow[]>('/mobile/stock/by-rack/suggest', {
    params: { type: 'rack', q: qq, limit },
  });
  return Array.isArray(res.data) ? res.data : [];
}

export async function listMainStockForMobile(params: {
  part_number?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  const res = await api.get<MainStockRow[]>('/mobile/stock/main', { params });
  return res.data;
}

export async function listStockByRackForMobile(params: {
  part_number?: string;
  rack_location?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const res = await api.get<StockByRackRow[]>('/mobile/stock/by-rack', { params });
  return res.data;
}
