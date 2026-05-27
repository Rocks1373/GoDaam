import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, Image } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { googleLogin, login } from '../api/authApi';
import { saveAuth } from '../storage/tokenStorage';
import { setSelectedWarehouseId } from '../storage/warehouseStorage';
import { registerDevice } from '../api/notificationsApi';
import { tryConfigurePushNotifications } from '../utils/expoPushSafe';
import { syncDriverLocationTrackingFromSession } from '../utils/driverLocationSync';
import { getDisplayApiOrigin, setAuthHeader } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeDefinition } from '../theme/palettes';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_TOKEN_KEY = 'godam_google_id_token';
const extra = Constants.expoConfig?.extra as { googleWebClientId?: string; googleAndroidClientId?: string } | undefined;
const GOOGLE_WEB =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || extra?.googleWebClientId || '';
const GOOGLE_ANDROID =
  process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || extra?.googleAndroidClientId || GOOGLE_WEB;
const GOOGLE_IOS = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || GOOGLE_WEB;
const HAS_GOOGLE = !!(GOOGLE_WEB || GOOGLE_ANDROID);

export type RootStackParamList = {
  ApiConfiguration: undefined;
  Login: undefined;
  AuthPending: { status?: string; message?: string } | undefined;
  Home: undefined;
  Notifications: undefined;
  Orders: undefined;
  SendForPickup: undefined;
  OrderDetail: { orderId: number };
  PickedOrders: undefined;
  PickedOrderDetail: { orderId: number };
  PickProof: { orderId: number };
  OrderImages: { orderId: number };
  StockPeek: { orderId: number; outboundItemId: number };
  ScanRack: undefined;
  RackUpdate: undefined;
  RackPickSelection: {
    orderId: number;
    outboundItemId: number;
    warehouseId?: number;
    /** Part used for rack list + picks (parent line or BOM child). */
    partNumber: string;
    sapPartNumber?: string;
    description?: string;
    requiredQty: number;
    pickedQty: number;
    remainingQty: number;
    /** When set, picks/transactions apply to this BOM child requirement. */
    outboundBomRequirementId?: number;
  };
  Receiving: undefined;
  UpcomingShipments: undefined;
  ReceiveShipment: { shipmentId: number };
  Settings: undefined;
  MainStockCheck: undefined;
  StockByRackCheck: undefined;
  Profile: undefined;
  DeliveryList: undefined;
  DeliveryDetail: { taskId: number };
  RoutePlanner: undefined;
};

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

function loginErrorExtra(e: unknown, apiOrigin: string): string {
  const ax = e as { response?: unknown; message?: string };
  const networkFailure = !ax.response;
  if (networkFailure) {
    return `\n\nConnecting to:\n${apiOrigin}\n\nTip: On cellular data, operators sometimes block port 8080. Use Wi‑Fi or open Configuration / Server settings and use HTTPS on port 443.`;
  }
  if (__DEV__) return `\n\nAPI base: ${apiOrigin}`;
  return '';
}

function createLoginStyles(c: ThemeDefinition) {
  return StyleSheet.create({
    wrap: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: c.background },
    brand: { width: 200, height: 120, alignSelf: 'center', marginBottom: 16 },
    sub: { fontSize: 13, color: c.textMuted, marginBottom: 20, textAlign: 'center' },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 12,
      marginBottom: 12,
      backgroundColor: c.inputBg,
      color: c.text,
    },
    btn: { backgroundColor: c.primary, padding: 14, borderRadius: 10, alignItems: 'center' },
    btnGoogle: {
      backgroundColor: '#1a1a1a',
      padding: 14,
      borderRadius: 10,
      alignItems: 'center',
      marginBottom: 16,
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 8,
    },
    btnText: { color: '#fff', fontWeight: '700' },
    orText: { textAlign: 'center', fontSize: 12, color: c.textMuted, marginBottom: 14, textTransform: 'uppercase', letterSpacing: 1 },
    linkBtn: { marginTop: 18, padding: 10, alignItems: 'center' },
    linkText: { color: c.link, fontWeight: '600', fontSize: 13 },
  });
}

export default function LoginScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => createLoginStyles(palette), [palette]);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);

  const [googleRequest, googleResponse, promptGoogle] = Google.useAuthRequest({
    webClientId: GOOGLE_WEB || undefined,
    androidClientId: GOOGLE_ANDROID || GOOGLE_WEB || undefined,
    iosClientId: GOOGLE_IOS || GOOGLE_WEB || undefined,
  });

  useEffect(() => {
    if (googleResponse?.type !== 'success') return;
    const idToken = googleResponse.authentication?.idToken || googleResponse.params?.id_token;
    if (!idToken) return;
    void handleGoogleToken(String(idToken));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleResponse]);

  const completeSession = async (res: Awaited<ReturnType<typeof login>>) => {
    await saveAuth(res.token, res.expires_at || null);
    setAuthHeader(res.token);
    const u = res.user;
    const wid =
      u.default_warehouse_id != null && Number(u.default_warehouse_id) > 0
        ? Number(u.default_warehouse_id)
        : u.warehouses && u.warehouses.length >= 1
          ? Number(u.warehouses[0].id)
          : null;
    await setSelectedWarehouseId(wid);
    void tryConfigurePushNotifications(registerDevice);
    void syncDriverLocationTrackingFromSession();
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  };

  const handleGoogleToken = async (idToken: string) => {
    setLoading(true);
    try {
      const res = await googleLogin(idToken);
      if (res.token && res.user) {
        await AsyncStorage.removeItem(GOOGLE_TOKEN_KEY);
        await completeSession(res as Awaited<ReturnType<typeof login>>);
        return;
      }
      await AsyncStorage.setItem(GOOGLE_TOKEN_KEY, idToken);
      navigation.replace('AuthPending', {
        status: res.status || 'PENDING_APPROVAL',
        message: res.message,
      });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { status?: string; message?: string; error?: string } } };
      const st = err.response?.data?.status;
      const msg = err.response?.data?.message || err.response?.data?.error || 'Google sign-in failed';
      if (st === 'PENDING_APPROVAL' || st === 'REJECTED' || st === 'BLOCKED') {
        await AsyncStorage.setItem(GOOGLE_TOKEN_KEY, idToken);
        navigation.replace('AuthPending', { status: st, message: msg });
        return;
      }
      Alert.alert('Login failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    setLoading(true);
    try {
      const res = await login(username.trim(), password);
      await completeSession(res);
    } catch (e: unknown) {
      const err = e as {
        response?: { data?: { error?: string; status?: string; message?: string } };
        message?: string;
      };
      const st = err.response?.data?.status;
      const pendingMsg = err.response?.data?.message;
      if (st === 'PENDING_APPROVAL' || st === 'REJECTED' || st === 'BLOCKED') {
        navigation.replace('AuthPending', { status: st, message: pendingMsg });
        return;
      }
      const base =
        err.response?.data?.error ||
        (err as { message?: string }).message ||
        'Error';
      const origin = getDisplayApiOrigin();
      const hint = loginErrorExtra(e, origin);
      Alert.alert('Login failed', `${base}${hint}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Image source={require('../../assets/icon.png')} style={styles.brand} resizeMode="contain" accessibilityLabel="GoDaam" />
      <Text style={styles.sub}>Warehouse — sign in</Text>

      {HAS_GOOGLE ? (
        <>
          <Pressable
            style={styles.btnGoogle}
            onPress={() => promptGoogle()}
            disabled={loading || !googleRequest}
            accessibilityRole="button"
            accessibilityLabel="Sign in with Google"
          >
            <Text style={styles.btnText}>Sign in with Google</Text>
          </Pressable>
          <Text style={styles.orText}>or use username</Text>
        </>
      ) : null}

      <TextInput
        style={styles.input}
        autoCapitalize="none"
        placeholder="Username"
        placeholderTextColor={palette.textMuted}
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={palette.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable style={styles.btn} onPress={submit} disabled={loading}>
        <Text style={styles.btnText}>{loading ? 'Signing in…' : 'Sign in with password'}</Text>
      </Pressable>
      <Pressable style={styles.linkBtn} onPress={() => navigation.navigate('ApiConfiguration')} disabled={loading}>
        <Text style={styles.linkText}>Server settings — Backend API URL</Text>
      </Pressable>
    </View>
  );
}
