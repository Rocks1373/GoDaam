import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, Image } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { login } from '../api/authApi';
import { saveAuth } from '../storage/tokenStorage';
import { API_ORIGIN, setAuthHeader } from '../api/client';

export type RootStackParamList = {
  Login: undefined;
  Home: undefined;
  Notifications: undefined;
  Orders: undefined;
  OrderDetail: { orderId: number };
  StockPeek: { orderId: number; outboundItemId: number };
  ScanRack: undefined;
  Receiving: undefined;
  Upcoming: undefined;
  MainStockCheck: undefined;
  StockByRackCheck: undefined;
  Profile: undefined;
  DeliveryList: undefined;
  DeliveryDetail: { taskId: number };
};

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

export default function LoginScreen({ navigation }: Props) {
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
      const base = err.response?.data?.error || err.message || 'Error';
      const hint = __DEV__ ? `\n\nAPI base: ${API_ORIGIN}` : '';
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
        value={username}
        onChangeText={setUsername}
      />
      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      <Pressable style={styles.btn} onPress={submit} disabled={loading}>
        <Text style={styles.btnText}>{loading ? 'Signing in…' : 'Sign in'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: '#f8fafc' },
  brand: { width: 200, height: 120, alignSelf: 'center', marginBottom: 16 },
  sub: { fontSize: 13, color: '#64748b', marginBottom: 20, textAlign: 'center' },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#fff',
  },
  btn: { backgroundColor: '#2563eb', padding: 14, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700' },
});
