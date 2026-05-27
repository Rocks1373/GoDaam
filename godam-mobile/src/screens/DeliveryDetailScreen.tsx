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
import { Ionicons } from '@expo/vector-icons';
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

function podFileName(mime: string) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'pod.png';
  return 'pod.jpg';
}

function isPickerResult(
  r: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null | undefined
): r is ImagePicker.ImagePickerResult {
  return Boolean(r && typeof r === 'object' && 'canceled' in r);
}

async function ensureCameraAndLibraryForPod(): Promise<boolean> {
  const cam = await ImagePicker.requestCameraPermissionsAsync();
  if (!cam.granted) {
    if (cam.canAskAgain === false) {
      Alert.alert(
        'Camera blocked',
        'Turn on Camera (and Photos) for GoDaam in system Settings → Apps → GoDaam → Permissions.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
    } else {
      Alert.alert('Camera', 'Camera permission is required to take a POD photo.');
    }
    return false;
  }
  // Saving the captured image to the gallery roll on some Android/iOS builds requires library access.
  const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!lib.granted) {
    if (lib.canAskAgain === false) {
      Alert.alert(
        'Photos blocked',
        'Photo library access is needed after you take a POD picture. Enable it in Settings → Apps → GoDaam.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]
      );
    } else {
      Alert.alert(
        'Photos',
        'Allow photo access so the POD picture can be saved and uploaded (required on many Android devices).'
      );
    }
    return false;
  }
  return true;
}

export default function DeliveryDetailScreen({ route, navigation }: Props) {
  const { taskId } = route.params;
  const [task, setTask] = useState<Record<string, unknown> | null>(null);
  const [dn, setDn] = useState<Record<string, unknown> | null>(null);
  const [outboundOrderId, setOutboundOrderId] = useState<number | null>(null);
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
      const oid = Number((res as { outbound_order_id?: number }).outbound_order_id);
      setOutboundOrderId(Number.isFinite(oid) && oid > 0 ? oid : null);
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

  /** Android can destroy MainActivity while the camera app is open; result arrives here. */
  useEffect(() => {
    if (String(task?.status || '') !== DS_OUT) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await ImagePicker.getPendingResultAsync();
        const pending = isPickerResult(raw) ? raw : null;
        if (cancelled || !pending || pending.canceled) return;
        const uri = pending.assets?.[0]?.uri;
        if (!uri) return;
        Alert.alert(
          'POD photo ready',
          'Your camera finished while the app was restarting. Upload this photo as POD?',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Upload',
              onPress: () => {
                void uploadPendingUri(uri, pending.assets?.[0]);
              },
            },
          ]
        );
      } catch {
        // getPendingResultAsync unsupported on some platforms
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [task?.status, taskId]);

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

  const uploadPendingUri = async (uri: string, asset?: ImagePicker.ImagePickerAsset) => {
    const mime = asset?.mimeType || (uri.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg');
    const name = podFileName(mime);
    await run(async () => uploadPod(taskId, uri, mime, name), 'POD uploaded.');
  };

  const onOpenMaps = () => {
    if (!gps) {
      Alert.alert('No GPS link', 'GPS was not saved on the delivery note.');
      return;
    }
    void Linking.openURL(gps.startsWith('http') ? gps : `https://maps.google.com/?q=${encodeURIComponent(address || gps)}`);
  };

  const onPickPodCamera = async () => {
    const ok = await ensureCameraAndLibraryForPod();
    if (!ok) return;
    try {
      const shot = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.75,
        allowsEditing: false,
        exif: false,
      });
      if (shot.canceled) return;
      const asset = shot.assets?.[0];
      const uri = asset?.uri;
      if (!uri) {
        const pendingRaw = await ImagePicker.getPendingResultAsync().catch(() => null);
        const pending = isPickerResult(pendingRaw) ? pendingRaw : null;
        const pUri = pending && !pending.canceled ? pending.assets?.[0]?.uri : null;
        if (pUri) {
          await uploadPendingUri(pUri, pending?.assets?.[0]);
          return;
        }
        Alert.alert(
          'POD photo',
          'No image was returned. Try again, or use “Choose POD from gallery” if the camera app closed unexpectedly.'
        );
        return;
      }
      const mime = asset?.mimeType || 'image/jpeg';
      await run(async () => uploadPod(taskId, uri, mime, podFileName(mime)), 'POD uploaded.');
    } catch (e: unknown) {
      Alert.alert('Camera', (e as Error)?.message || 'Could not open the camera.');
    }
  };

  const onPickPodGallery = async () => {
    const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!lib.granted) {
      if (lib.canAskAgain === false) {
        Alert.alert('Photos blocked', 'Enable Photos / Media for GoDaam in system Settings.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ]);
      } else {
        Alert.alert('Photos', 'Photo access is required to attach a POD image from your gallery.');
      }
      return;
    }
    try {
      const shot = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.85,
        allowsEditing: false,
      });
      if (shot.canceled || !shot.assets?.[0]?.uri) return;
      const asset = shot.assets[0];
      const mime = asset.mimeType || 'image/jpeg';
      await run(async () => uploadPod(taskId, asset.uri, mime, podFileName(mime)), 'POD uploaded.');
    } catch (e: unknown) {
      Alert.alert('Gallery', (e as Error)?.message || 'Could not open the photo library.');
    }
  };

  const onPickPod = () => {
    Alert.alert('Upload POD', 'Add a proof-of-delivery photo.', [
      { text: 'Take photo', onPress: () => void onPickPodCamera() },
      { text: 'Choose from gallery', onPress: () => void onPickPodGallery() },
      { text: 'Cancel', style: 'cancel' },
    ]);
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

      {outboundOrderId ? (
        <Pressable
          style={styles.seeImagesBtn}
          onPress={() => navigation.navigate('OrderImages', { orderId: outboundOrderId })}
        >
          <Ionicons name="images-outline" size={20} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.seeImagesTitle}>See order images</Text>
            <Text style={styles.seeImagesSub}>Pick proof photos on Google Drive</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#fff" />
        </Pressable>
      ) : null}

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
        <>
          <Pressable style={[styles.btn, busy && styles.disabled]} disabled={busy} onPress={() => void onPickPod()}>
            <Text style={styles.btnText}>Upload POD (camera or gallery)</Text>
          </Pressable>
          <Text style={styles.hint}>
            Allow Camera and Photos when asked. If the camera does not open, use gallery or enable permissions in
            Settings.
          </Text>
        </>
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
  hint: { marginTop: 8, fontSize: 12, color: '#64748b', lineHeight: 18 },
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
  seeImagesBtn: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#2563eb',
    borderRadius: 12,
    padding: 14,
  },
  seeImagesTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  seeImagesSub: { color: '#dbeafe', fontSize: 11, marginTop: 2 },
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
