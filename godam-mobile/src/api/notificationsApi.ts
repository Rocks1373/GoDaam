import { api } from './client';
import * as Device from 'expo-device';

export type NotificationRow = {
  id: number;
  title: string;
  body: string;
  data_json: string | null;
  created_at: string;
  read_at: string | null;
};

export async function registerDevice(expo_push_token: string) {
  await api.post('/notifications/register-device', {
    expo_push_token,
    device_id:
      Device.osInternalBuildId ||
      Device.modelId ||
      `${Device.osName || 'unknown'}-${Device.modelName || Device.deviceName || 'device'}`,
    platform: Device.osName || 'unknown',
    device_name: Device.deviceName || Device.modelName || null,
    device_model: Device.modelName || Device.modelId || null,
  });
}

export async function listNotifications(unreadOnly = false) {
  const res = await api.get<NotificationRow[]>('/notifications', {
    params: { unread_only: unreadOnly },
  });
  return res.data;
}

export async function getUnreadNotificationCount() {
  const res = await api.get<{ count: number }>('/notifications/unread-count');
  return Number(res.data?.count) || 0;
}

export async function markNotificationRead(id: number) {
  await api.post(`/notifications/${id}/read`);
}

export async function markAllNotificationsRead() {
  await api.post('/notifications/mark-all-read');
}

export type TestPushResponse = {
  ok: boolean;
  devices?: number;
  result?: {
    ok: boolean;
    sent: number;
    errors?: Array<{ to?: string; error: string }>;
    tickets?: Array<{ status?: string; id?: string; message?: string }>;
  };
  error?: string;
};

export async function testMyPush(title?: string, body?: string) {
  const res = await api.post<TestPushResponse>('/notifications/test-my-push', { title, body });
  return res.data;
}
