import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import {
  closeDelivery,
  confirmPickup,
  getDeliveryTask,
  openDelivery,
  uploadPod,
} from '../api/deliveriesApi';

type Props = NativeStackScreenProps<RootStackParamList, 'DeliveryDetail'>;

const DS_CONFIRMED = 'Confirmed';
const DS_OPENED = 'Opened by Driver';
const DS_OUT = 'Out For Delivery';
const DS_POD = 'POD Uploaded';
const DS_CLOSED = 'Closed';

export default function DeliveryDetailScreen({ route, navigation }: Props) {
  const { taskId } = route.params;
  const [task, setTask] = useState<Record<string, unknown> | null>(null);
  const [dn, setDn] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const res = await getDeliveryTask(taskId);
      setTask((res.task || null) as Record<string, unknown> | null);
      setDn((res.delivery_note || null) as Record<string, unknown> | null);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setErr(msg || (e as Error).message || 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = String(dn?.outbound_number || task?.outbound_number || '');
    navigation.setOptions({ title: t ? `Delivery ${t}` : 'Delivery' });
  }, [navigation, dn, task]);

  const st = String(task?.status || '');
  const gps = String(task?.gps_link || dn?.gps || '').trim();
  const address = String(task?.delivery_address || dn?.delivery_address || '');

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) Alert.alert('OK', okMsg);
      await load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      Alert.alert('Error', msg || (e as Error).message || 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const onOpenMaps = () => {
    if (!gps) {
      Alert.alert('No GPS link', 'GPS was not saved on the delivery note.');
      return;
    }
    void Linking.openURL(gps.startsWith('http') ? gps : `https://maps.google.com/?q=${encodeURIComponent(address || gps)}`);
  };

  const onPickPod = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera', 'Camera permission is required for POD.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (shot.canceled || !shot.assets?.[0]?.uri) return;
    const uri = shot.assets[0].uri;
    await run(async () => uploadPod(taskId, uri), 'POD uploaded.');
  };

  if (loading && !task) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (err && !task) {
    return (
      <View style={styles.center}>
        <Text style={styles.err}>{err}</Text>
        <Pressable style={styles.btn} onPress={() => void load()}>
          <Text style={styles.btnText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.pad}>
      {err ? <Text style={styles.warn}>{err}</Text> : null}
      <Text style={styles.label}>Outbound</Text>
      <Text style={styles.val}>{String(task?.outbound_number || '—')}</Text>
      <Text style={styles.label}>Customer</Text>
      <Text style={styles.val}>{String(task?.customer_name || '—')}</Text>
      <Text style={styles.label}>City</Text>
      <Text style={styles.val}>{String(task?.city_name || dn?.city_name || '—')}</Text>
      <Text style={styles.label}>Status</Text>
      <Text style={styles.status}>{st || '—'}</Text>
      <Text style={styles.label}>Address</Text>
      <Text style={styles.addr}>{address || '—'}</Text>

      <Pressable style={styles.secondary} onPress={onOpenMaps}>
        <Text style={styles.secondaryText}>Open in Maps</Text>
      </Pressable>

      {st === DS_CONFIRMED ? (
        <Pressable
          style={[styles.btn, busy && styles.disabled]}
          disabled={busy}
          onPress={() => void run(async () => openDelivery(taskId), 'Delivery opened.')}
        >
          <Text style={styles.btnText}>Open Delivery</Text>
        </Pressable>
      ) : null}

      {st === DS_OPENED ? (
        <Pressable
          style={[styles.btn, busy && styles.disabled]}
          disabled={busy}
          onPress={() => void run(async () => confirmPickup(taskId), 'Pickup confirmed — out for delivery.')}
        >
          <Text style={styles.btnText}>Confirm Pickup</Text>
        </Pressable>
      ) : null}

      {st === DS_OUT ? (
        <Pressable style={[styles.btn, busy && styles.disabled]} disabled={busy} onPress={() => void onPickPod()}>
          <Text style={styles.btnText}>Upload POD (camera)</Text>
        </Pressable>
      ) : null}

      {st === DS_POD ? (
        <Pressable
          style={[styles.btn, styles.danger, busy && styles.disabled]}
          disabled={busy}
          onPress={() =>
            void run(async () => closeDelivery(taskId), 'Order closed. Warehouse will mark delivered.')
          }
        >
          <Text style={styles.btnText}>Close Order</Text>
        </Pressable>
      ) : null}

      {st === DS_CLOSED ? <Text style={styles.done}>This delivery is closed.</Text> : null}

      {busy ? <ActivityIndicator style={{ marginTop: 16 }} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9' },
  pad: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  err: { color: '#b91c1c', textAlign: 'center', marginBottom: 12 },
  warn: { color: '#92400e', marginBottom: 10 },
  label: { fontSize: 11, fontWeight: '700', color: '#64748b', marginTop: 12 },
  val: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  status: { fontSize: 15, fontWeight: '800', color: '#1d4ed8' },
  addr: { fontSize: 14, color: '#334155', lineHeight: 20 },
  secondary: {
    marginTop: 14,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#e2e8f0',
  },
  secondaryText: { fontWeight: '700', color: '#0f172a' },
  btn: {
    marginTop: 16,
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  danger: { backgroundColor: '#b45309' },
  disabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontWeight: '800' },
  done: { marginTop: 20, fontSize: 14, color: '#15803d', fontWeight: '600' },
});
