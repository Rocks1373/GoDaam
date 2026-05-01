import { api } from './client';
import * as Device from 'expo-device';

export async function registerDevice(expo_push_token: string) {
  await api.post('/notifications/register-device', {
    expo_push_token,
    device_id: Device.osInternalBuildId || Device.modelId || 'unknown',
    platform: Device.osName,
  });
}
