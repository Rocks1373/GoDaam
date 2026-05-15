import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

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

export async function tryConfigurePushNotifications(
  registerDeviceApi: (expoPushToken: string) => Promise<void>
): Promise<void> {
  if (shouldSkipExpoNotifications()) {
    return;
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

    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;

    const projectId = resolveExpoProjectId();
    const tok = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const token = tok.data;
    if (token) await registerDeviceApi(token);
  } catch {
    // Missing EAS projectId, simulator, etc.
  }
}
