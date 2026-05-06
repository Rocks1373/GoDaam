import { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import LoginScreen, { type RootStackParamList } from './src/screens/LoginScreen';
import ApiConfigurationScreen from './src/screens/ApiConfigurationScreen';
import HomeScreen from './src/screens/HomeScreen';
import OrdersScreen from './src/screens/OrdersScreen';
import OrderDetailScreen from './src/screens/OrderDetailScreen';
import StockPeekScreen from './src/screens/StockPeekScreen';
import ScanRackScreen from './src/screens/ScanRackScreen';
import ReceivingScreen from './src/screens/ReceivingScreen';
import UpcomingOrdersScreen from './src/screens/UpcomingOrdersScreen';
import MainStockCheckScreen from './src/screens/MainStockCheckScreen';
import StockByRackCheckScreen from './src/screens/StockByRackCheckScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';
import DeliveryListScreen from './src/screens/DeliveryListScreen';
import DeliveryDetailScreen from './src/screens/DeliveryDetailScreen';
import RoutePlannerScreen from './src/screens/RoutePlannerScreen';
import { loadAuth, isExpiredIso, clearAuth } from './src/storage/tokenStorage';
import { initApiClientFromStorage, setAuthHeader } from './src/api/client';
import { AppErrorBoundary } from './src/components/AppErrorBoundary';

const Stack = createNativeStackNavigator<RootStackParamList>();

type BootRoute = 'ApiConfiguration' | 'Login' | 'Home';

export default function App() {
  const [boot, setBoot] = useState<{ ready: boolean; initial: BootRoute }>({
    ready: false,
    initial: 'ApiConfiguration',
  });

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
        setBoot({ ready: true, initial: 'Home' });
      }
    })();
  }, []);

  if (!boot.ready) {
    return (
      <SafeAreaProvider>
        <AppErrorBoundary>
          <View style={styles.boot}>
            <ActivityIndicator size="large" color="#2563eb" />
          </View>
        </AppErrorBoundary>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
      <NavigationContainer>
        <Stack.Navigator initialRouteName={boot.initial} screenOptions={{ headerShown: true }}>
          <Stack.Screen
            name="ApiConfiguration"
            component={ApiConfigurationScreen}
            options={{ title: 'Configuration' }}
          />
          <Stack.Screen name="Login" component={LoginScreen} options={{ title: 'GoDaam Login' }} />
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={{ title: 'GoDaam', headerStyle: { backgroundColor: '#f1f5f9' } }}
          />
          <Stack.Screen
            name="Notifications"
            component={NotificationsScreen}
            options={{ title: 'Notifications', headerStyle: { backgroundColor: '#f1f5f9' } }}
          />
          <Stack.Screen name="Orders" component={OrdersScreen} />
          <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: 'Order' }} />
          <Stack.Screen
            name="StockPeek"
            component={StockPeekScreen}
            options={{ title: 'Stock review (read-only)' }}
          />
          <Stack.Screen name="ScanRack" component={ScanRackScreen} />
          <Stack.Screen name="Receiving" component={ReceivingScreen} />
          <Stack.Screen
            name="MainStockCheck"
            component={MainStockCheckScreen}
            options={{ title: 'Main stock (view)' }}
          />
          <Stack.Screen
            name="StockByRackCheck"
            component={StockByRackCheckScreen}
            options={{ title: 'Stock by rack (view)' }}
          />
          <Stack.Screen name="Upcoming" component={UpcomingOrdersScreen} />
          <Stack.Screen name="DeliveryList" component={DeliveryListScreen} options={{ title: 'Delivery' }} />
          <Stack.Screen name="DeliveryDetail" component={DeliveryDetailScreen} />
          <Stack.Screen name="RoutePlanner" component={RoutePlannerScreen} options={{ title: 'Route planner' }} />
          <Stack.Screen name="Profile" component={ProfileScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8fafc' },
});
