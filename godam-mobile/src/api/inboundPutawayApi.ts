import { api } from './client';

export type InboundBatchRow = {
  id: number;
  batch_name: string;
  vendor_name: string | null;
  upload_date: string | null;
  status: string;
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

export async function listInboundBatches(): Promise<InboundBatchRow[]> {
  const res = await api.get<InboundBatchRow[]>('/mobile/inbound-batches');
  return Array.isArray(res.data) ? res.data : [];
}

export async function getInboundBatchDetail(batchId: number): Promise<{ batch: InboundBatchRow; items: InboundItemRow[] }> {
  const res = await api.get(`/mobile/inbound-batches/${batchId}`);
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
  const res = await api.post('/mobile/putaway/upload', payload);
  return res.data as { ok: boolean; item?: InboundItemRow };
}
