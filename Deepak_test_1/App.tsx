import { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

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
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';

const Stack = createNativeStackNavigator<RootStackParamList>();

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
          <NavigationContainer theme={navigationTheme}>
            <Stack.Navigator initialRouteName={boot.initial} screenOptions={headerScreenOptions}>
              <Stack.Screen name="ApiConfiguration" component={ApiConfigurationScreen} options={{ title: 'Configuration' }} />
              <Stack.Screen name="Login" component={LoginScreen} options={{ title: 'GoDaam Login' }} />
              <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'GoDaam' }} />
              <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: 'Notifications' }} />
              <Stack.Screen name="Orders" component={OrdersScreen} />
              <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: 'Order' }} />
              <Stack.Screen name="StockPeek" component={StockPeekScreen} options={{ title: 'Stock review (read-only)' }} />
              <Stack.Screen name="ScanRack" component={ScanRackScreen} />
              <Stack.Screen name="Receiving" component={ReceivingScreen} />
              <Stack.Screen name="MainStockCheck" component={MainStockCheckScreen} options={{ title: 'Main stock (view)' }} />
              <Stack.Screen name="StockByRackCheck" component={StockByRackCheckScreen} options={{ title: 'Stock by rack (view)' }} />
              <Stack.Screen name="Upcoming" component={UpcomingOrdersScreen} />
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
