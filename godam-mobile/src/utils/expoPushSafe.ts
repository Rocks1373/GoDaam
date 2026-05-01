import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

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
          shouldPlaySound: false,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });
      notificationHandlerSet = true;
    }

    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') return;

    const tok = await Notifications.getExpoPushTokenAsync();
    const token = tok.data;
    if (token) await registerDeviceApi(token);
  } catch {
    // Missing EAS projectId, simulator, etc.
  }
}
