import { api } from './client';

export type DriverDeliveryTask = {
  id: number;
  dn_id: number;
  outbound_number?: string;
  customer_name?: string;
  city_name?: string;
  status?: string;
  driver_name?: string;
  driver_mobile?: string;
  gps_link?: string;
  delivery_address?: string;
  pod_file_path?: string;
};

export async function listDeliveries() {
  const { data } = await api.get<DriverDeliveryTask[]>('/mobile/deliveries');
  return data;
}

export async function getDeliveryTask(id: number) {
  const { data } = await api.get<{ task: DriverDeliveryTask; delivery_note: Record<string, unknown> }>(
    `/mobile/deliveries/${id}`
  );
  return data;
}

export async function openDelivery(taskId: number) {
  const { data } = await api.post(`/mobile/deliveries/${taskId}/open`);
  return data;
}

export async function confirmPickup(taskId: number) {
  const { data } = await api.post(`/mobile/deliveries/${taskId}/confirm-pickup`);
  return data;
}

export async function uploadPod(taskId: number, fileUri: string, mimeType = 'image/jpeg') {
  const form = new FormData();
  form.append('file', {
    uri: fileUri,
    name: 'pod.jpg',
    type: mimeType,
  } as unknown as Blob);
  const { data } = await api.post(`/mobile/deliveries/${taskId}/upload-pod`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export async function closeDelivery(taskId: number) {
  const { data } = await api.post(`/mobile/deliveries/${taskId}/close`);
  return data;
}
