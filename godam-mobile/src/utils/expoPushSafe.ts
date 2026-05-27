import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import { formatApiError } from '../api/client';

/** Must match backend/services/notificationService.js ANDROID_CHANNEL_ID */
export const GODAM_PUSH_CHANNEL_ID = 'godam-alerts-v2';

function resolveExpoProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/**
 * Remote push was removed from Expo Go on Android (SDK 53+).
 * Importing `expo-notifications` there throws — gate all loads behind this check.
 */
export function shouldSkipExpoNotifications(): boolean {
  return Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

let notificationHandlerSet = false;

export type PushSetupResult = {
  ok: boolean;
  skipped?: boolean;
  permissionStatus?: string;
  tokenRegistered?: boolean;
  tokenPrefix?: string;
  error?: string;
};

async function ensureAndroidNotificationChannel(
  Notifications: typeof import('expo-notifications')
): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(GODAM_PUSH_CHANNEL_ID, {
    name: 'GoDaam alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#FF6600',
    sound: 'default',
    enableVibrate: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    showBadge: true,
  });
}

export async function tryConfigurePushNotifications(
  registerDeviceApi: (expoPushToken: string) => Promise<void>
): Promise<PushSetupResult> {
  if (shouldSkipExpoNotifications()) {
    return { ok: false, skipped: true, error: 'Expo Go on Android does not support remote push.' };
  }

  try {
    const Notifications = await import('expo-notifications');

    if (!notificationHandlerSet) {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });
      notificationHandlerSet = true;
    }

    await ensureAndroidNotificationChannel(Notifications);

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return { ok: false, permissionStatus: finalStatus, error: 'Notification permission is not granted.' };
    }

    const projectId = resolveExpoProjectId();
    const tok = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const token = tok.data;
    if (!token) return { ok: false, permissionStatus: finalStatus, error: 'Expo push token was empty.' };
    await registerDeviceApi(token);
    return {
      ok: true,
      permissionStatus: finalStatus,
      tokenRegistered: true,
      tokenPrefix: token.slice(0, 28),
    };
  } catch (err) {
    const message = formatApiError(err);
    console.warn('Push registration failed:', message);
    return { ok: false, error: message };
  }
}
