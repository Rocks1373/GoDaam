import { useEffect, useState } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, Alert, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import LoginScreen, { type RootStackParamList } from './src/screens/LoginScreen';
import AuthPendingScreen from './src/screens/AuthPendingScreen';
import ApiConfigurationScreen from './src/screens/ApiConfigurationScreen';
import HomeScreen from './src/screens/HomeScreen';
import OrdersScreen from './src/screens/OrdersScreen';
import SendForPickupScreen from './src/screens/SendForPickupScreen';
import OrderDetailScreen from './src/screens/OrderDetailScreen';
import PickedOrdersScreen from './src/screens/PickedOrdersScreen';
import PickedOrderDetailScreen from './src/screens/PickedOrderDetailScreen';
import PickProofScreen from './src/screens/PickProofScreen';
import OrderImagesScreen from './src/screens/OrderImagesScreen';
import StockPeekScreen from './src/screens/StockPeekScreen';
import ScanRackScreen from './src/screens/ScanRackScreen';
import RackUpdateScreen from './src/screens/RackUpdateScreen';
import RackPickSelectionScreen from './src/screens/RackPickSelectionScreen';
import ReceivingScreen from './src/screens/ReceivingScreen';
import UpcomingShipmentsScreen from './src/screens/UpcomingShipmentsScreen';
import ReceiveShipmentScreen from './src/screens/ReceiveShipmentScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import MainStockCheckScreen from './src/screens/MainStockCheckScreen';
import StockByRackCheckScreen from './src/screens/StockByRackCheckScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import DeliveryListScreen from './src/screens/DeliveryListScreen';
import DeliveryDetailScreen from './src/screens/DeliveryDetailScreen';
import RoutePlannerScreen from './src/screens/RoutePlannerScreen';
import { loadAuth, isExpiredIso, clearAuth } from './src/storage/tokenStorage';
import { initApiClientFromStorage, setAuthHeader } from './src/api/client';
import { subscribeSessionExpired } from './src/api/sessionEvents';
import { registerDevice } from './src/api/notificationsApi';
import { tryConfigurePushNotifications } from './src/utils/expoPushSafe';
import { AppErrorBoundary } from './src/components/AppErrorBoundary';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { syncDriverLocationTrackingFromSession } from './src/utils/driverLocationSync';
import { stopDriverLocationTracking } from './src/services/driverLocationTracking';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const rootNavigationRef = createNavigationContainerRef<RootStackParamList>();

type BootRoute = 'ApiConfiguration' | 'Login' | 'Home';

function AppNavigator() {
  const { palette, navigationTheme, themeId } = useTheme();
  const [boot, setBoot] = useState<{ ready: boolean; initial: BootRoute }>({
    ready: false,
    initial: 'ApiConfiguration',
  });

  const headerScreenOptions = {
    headerShown: true as const,
    headerStyle: { backgroundColor: palette.headerBg },
    headerTintColor: palette.headerTitle,
    headerTitleStyle: { color: palette.headerTitle },
    contentStyle: { backgroundColor: palette.background },
  };

  useEffect(() => {
    return subscribeSessionExpired((message) => {
      void stopDriverLocationTracking();
      if (rootNavigationRef.isReady()) {
        const route = rootNavigationRef.getCurrentRoute()?.name;
        if (route !== 'Login' && route !== 'ApiConfiguration') {
          rootNavigationRef.reset({ index: 0, routes: [{ name: 'Login' }] });
          Alert.alert('Session ended', message);
        }
      }
    });
  }, []);

  useEffect(() => {
    (async () => {
      const hasSavedUrl = await initApiClientFromStorage();
      if (!hasSavedUrl) {
        await clearAuth();
        setAuthHeader(null);
        setBoot({ ready: true, initial: 'ApiConfiguration' });
        return;
      }
      const { token, expiresAt } = await loadAuth();
      if (!token || isExpiredIso(expiresAt)) {
        await clearAuth();
        setAuthHeader(null);
        setBoot({ ready: true, initial: 'Login' });
      } else {
        setAuthHeader(token);
        void tryConfigurePushNotifications(registerDevice);
        void syncDriverLocationTrackingFromSession();
        setBoot({ ready: true, initial: 'Home' });
      }
    })();
  }, []);

  if (!boot.ready) {
    return (
      <SafeAreaProvider>
        <AppErrorBoundary>
          <View style={[styles.boot, { backgroundColor: palette.background }]}>
            <ActivityIndicator size="large" color={palette.primary} />
          </View>
        </AppErrorBoundary>
      </SafeAreaProvider>
    );
  }

  return (
    <>
      <StatusBar style={themeId === 'dark' ? 'light' : 'dark'} />
      <SafeAreaProvider>
        <AppErrorBoundary>
          <NavigationContainer ref={rootNavigationRef} theme={navigationTheme}>
            <Stack.Navigator initialRouteName={boot.initial} screenOptions={headerScreenOptions}>
              <Stack.Screen name="ApiConfiguration" component={ApiConfigurationScreen} options={{ title: 'Configuration' }} />
              <Stack.Screen name="Login" component={LoginScreen} options={{ title: 'GoDaam Login' }} />
              <Stack.Screen name="AuthPending" component={AuthPendingScreen} options={{ title: 'Approval pending' }} />
              <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'GoDaam' }} />
              <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications' }} />
              <Stack.Screen name="Orders" component={OrdersScreen} />
              <Stack.Screen name="SendForPickup" component={SendForPickupScreen} options={{ title: 'Send for pick' }} />
              <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: 'Order' }} />
              <Stack.Screen name="PickedOrders" component={PickedOrdersScreen} />
              <Stack.Screen name="PickedOrderDetail" component={PickedOrderDetailScreen} />
              <Stack.Screen
                name="PickProof"
                component={PickProofScreen}
                options={{ title: 'Order images (pick proof)' }}
              />
              <Stack.Screen
                name="OrderImages"
                component={OrderImagesScreen}
                options={{ title: 'Order images' }}
              />
              <Stack.Screen name="StockPeek" component={StockPeekScreen} options={{ title: 'Stock review (read-only)' }} />
              <Stack.Screen name="ScanRack" component={ScanRackScreen} />
              <Stack.Screen name="RackUpdate" component={RackUpdateScreen} options={{ title: 'Rack Update' }} />
              <Stack.Screen
                name="RackPickSelection"
                component={RackPickSelectionScreen}
                options={{ title: 'Part pick' }}
              />
              <Stack.Screen name="Receiving" component={ReceivingScreen} />
              <Stack.Screen name="UpcomingShipments" component={UpcomingShipmentsScreen} options={{ title: 'Upcoming Shipments' }} />
              <Stack.Screen name="ReceiveShipment" component={ReceiveShipmentScreen} options={{ title: 'Receive Shipment' }} />
              <Stack.Screen name="MainStockCheck" component={MainStockCheckScreen} options={{ title: 'Main stock (view)' }} />
              <Stack.Screen name="StockByRackCheck" component={StockByRackCheckScreen} options={{ title: 'Stock by rack (view)' }} />
              <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
              <Stack.Screen name="DeliveryList" component={DeliveryListScreen} options={{ title: 'Delivery' }} />
              <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} />
              <Stack.Screen name="RoutePlanner" component={RoutePlannerScreen} options={{ title: 'Route planner' }} />
              <Stack.Screen name="Profile" component={ProfileScreen} />
            </Stack.Navigator>
          </NavigationContainer>
        </AppErrorBoundary>
      </SafeAreaProvider>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppNavigator />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center' },
});
