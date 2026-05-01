import { api } from './client';

export async function receiving(payload: {
  scan_rack?: string;
  rack_location?: string;
  part_number: string;
  sap_part_number?: string;
  description?: string;
  qty_in: number;
  reference_no?: string;
  remarks?: string;
}) {
  const res = await api.post('/mobile/receiving', payload);
  return res.data;
}
