import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, Image } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { login } from '../api/authApi';
import { saveAuth } from '../storage/tokenStorage';
import { getDisplayApiOrigin, setAuthHeader } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeDefinition } from '../theme/palettes';

export type RootStackParamList = {
  ApiConfiguration: undefined;
  Login: undefined;
  Home: undefined;
  Notifications: undefined;
  Orders: undefined;
  OrderDetail: { orderId: number };
  PickedOrders: undefined;
  PickedOrderDetail: { orderId: number };
  StockPeek: { orderId: number; outboundItemId: number };
  ScanRack: undefined;
  Receiving: undefined;
  Upcoming: undefined;
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
    btnText: { color: '#fff', fontWeight: '700' },
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

  const submit = async () => {
    setLoading(true);
    try {
      const res = await login(username.trim(), password);
      await saveAuth(res.token, res.expires_at || null);
      setAuthHeader(res.token);
      navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
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
        <Text style={styles.btnText}>{loading ? 'Signing in…' : 'Sign in'}</Text>
      </Pressable>
      <Pressable style={styles.linkBtn} onPress={() => navigation.navigate('ApiConfiguration')} disabled={loading}>
        <Text style={styles.linkText}>Server settings — Backend API URL</Text>
      </Pressable>
    </View>
  );
}
