import { api } from './client';

export type InboundBatchRow = {
  id: number;
  batch_name: string;
  vendor_name: string | null;
  upload_date: string | null;
  status: string;
  lpo?: string | null;
  sap_po?: string | null;
  invoice_number?: string | null;
  item_count?: number;
  sum_remaining?: number;
};

export type InboundItemRow = {
  id: number;
  inbound_batch_id: number;
  part_number: string;
  sap_part_number: string | null;
  description: string | null;
  total_qty: number;
  putaway_qty: number;
  remaining_qty: number;
  status: string;
};

const inboundScope = { skipWarehouseHeader: true as const };

export async function listInboundBatches(): Promise<InboundBatchRow[]> {
  const res = await api.get<InboundBatchRow[]>('/mobile/inbound-batches', inboundScope);
  return Array.isArray(res.data) ? res.data : [];
}

export async function getInboundBatchDetail(batchId: number): Promise<{ batch: InboundBatchRow; items: InboundItemRow[] }> {
  const res = await api.get(`/mobile/inbound-batches/${batchId}`, inboundScope);
  return res.data as { batch: InboundBatchRow; items: InboundItemRow[] };
}

export async function uploadPutaway(payload: {
  inbound_batch_id: number;
  inbound_item_id: number;
  part_number: string;
  rack_location: string;
  qty: number;
  transaction_date?: string;
  remarks?: string;
}) {
  const res = await api.post('/mobile/putaway/upload', payload, inboundScope);
  return res.data as { ok: boolean; item?: InboundItemRow };
}
