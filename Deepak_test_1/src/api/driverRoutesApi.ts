import { api } from './client';

export type DriverRouteStop = {
  id: number;
  driver_user_id: number;
  driver_delivery_task_id: number;
  outbound_number?: string;
  customer_name?: string;
  city_name?: string;
  gps_link?: string;
  latitude?: number | null;
  longitude?: number | null;
  sequence_no?: number | null;
  route_status?: string;
  updated_at?: string;
};

export async function listActiveDriverDeliveries() {
  const { data } = await api.get('/mobile/driver-deliveries/active');
  return data as unknown[];
}

export async function getCurrentRoute() {
  const { data } = await api.get<DriverRouteStop[]>('/mobile/driver-routes/current');
  return data;
}

export async function autoSortNearest(payload?: { driver_latitude?: number; driver_longitude?: number }) {
  const { data } = await api.post('/mobile/driver-routes/auto-sort', payload || {});
  return data as { stops: DriverRouteStop[]; warning?: string | null; origin?: { latitude: number; longitude: number } };
}

export async function saveManualSequence(stops: { driver_delivery_task_id: number; sequence_no: number }[]) {
  const { data } = await api.post('/mobile/driver-routes/save-sequence', { stops });
  return data as { stops: DriverRouteStop[] };
}

