import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { getPickedOrderDetail, type PickedTransactionRow } from '../api/pickedOrdersApi';
import { fetchOrderImagesGallery } from '../api/pickProofApi';
import { OrderIdentityLabels } from '../components/OrderIdentityLabels';
import { orderNavTitle } from '../utils/orderDisplay';

type Props = NativeStackScreenProps<RootStackParamList, 'PickedOrderDetail'>;

function fmt(v: unknown) {
  const s = String(v ?? '').trim();
  return s || '—';
}

export default function PickedOrderDetailScreen({ route, navigation }: Props) {
  const { orderId } = route.params;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Record<string, unknown> | null>(null);
  const [order, setOrder] = useState<Record<string, unknown> | null>(null);
  const [tx, setTx] = useState<PickedTransactionRow[]>([]);
  const [photoCount, setPhotoCount] = useState(0);

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const data = await getPickedOrderDetail(orderId);
      setPicked((data.picked_order || null) as Record<string, unknown> | null);
      setOrder((data.order || null) as Record<string, unknown> | null);
      setTx(Array.isArray(data.picked_transactions) ? data.picked_transactions : []);
      try {
        const gal = await fetchOrderImagesGallery(orderId);
        setPhotoCount(gal.total_photos || 0);
      } catch {
        setPhotoCount(0);
      }
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error;
      setErr(msg || (e as Error).message || 'Failed to load');
      setPicked(null);
      setOrder(null);
      setTx([]);
      setPhotoCount(0);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const row = (order || picked || { order_id: orderId }) as Record<string, unknown>;
    navigation.setOptions({ title: `Picked · ${orderNavTitle(row)}` });
  }, [navigation, picked, order, orderId]);

  const pickedBy = useMemo(() => {
    const names = tx
      .map((t) => String(t.user_name || '').trim())
      .filter(Boolean);
    return [...new Set(names)].join(', ') || '—';
  }, [tx]);

  if (loading && !picked) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (err && !picked) {
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

      <View style={styles.card}>
        <OrderIdentityLabels item={(order || picked || {}) as Record<string, unknown>} />
        <Text style={[styles.row, { marginTop: 10 }]}>Sales Doc: {fmt(picked?.sales_doc || order?.sales_doc || order?.sales_order_number)}</Text>
        <Text style={styles.row}>Customer Ref: {fmt(picked?.customer_reference || order?.customer_reference)}</Text>
        <Text style={styles.row}>Status: {fmt(order?.status || 'Picked')}</Text>
        <Text style={styles.row}>Picked by: {pickedBy}</Text>
        <Text style={styles.row}>Confirmed by: {fmt(picked?.confirmed_by_user_name)}</Text>
        <Text style={styles.row}>Confirmed at: {fmt(picked?.confirmed_at)}</Text>
      </View>

      <View style={styles.actionRow}>
        <Pressable
          style={styles.seeImagesBtn}
          onPress={() => navigation.navigate('OrderImages', { orderId })}
        >
          <Ionicons name="images-outline" size={20} color="#fff" />
          <View style={{ flex: 1 }}>
            <Text style={styles.seeImagesTitle}>See images</Text>
            <Text style={styles.seeImagesSub}>
              {photoCount > 0
                ? `${photoCount} photo${photoCount === 1 ? '' : 's'} on Google Drive`
                : 'Open Order Images folder'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#fff" />
        </Pressable>
        <Pressable
          style={styles.takeMoreBtn}
          onPress={() => navigation.navigate('PickProof', { orderId })}
        >
          <Ionicons name="camera-outline" size={18} color="#0f172a" />
          <Text style={styles.takeMoreText}>Take more pictures</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Pick transactions</Text>
      {!tx.length ? (
        <Text style={styles.empty}>No picked transactions recorded.</Text>
      ) : (
        tx.map((t) => (
          <View key={String(t.id)} style={styles.txCard}>
            <Text style={styles.txTitle}>{fmt(t.material || t.sap_part_number || t.description)}</Text>
            <Text style={styles.txRow}>Rack: {fmt(t.rack_location)} · Qty: {fmt(t.picked_qty)}</Text>
            <Text style={styles.txRow}>By: {fmt(t.user_name)} · At: {fmt(t.picked_at)}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9' },
  pad: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  err: { color: '#b91c1c', textAlign: 'center', marginBottom: 12 },
  warn: { color: '#92400e', marginBottom: 10 },
  btn: { backgroundColor: '#2563eb', paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12 },
  btnText: { color: '#fff', fontWeight: '800' },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#e2e8f0' },
  row: { fontSize: 12, color: '#334155', marginTop: 6 },
  actionRow: { marginTop: 4, marginBottom: 8, gap: 10 },
  seeImagesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#2563eb',
    borderRadius: 14,
    padding: 14,
  },
  seeImagesTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  seeImagesSub: { color: '#dbeafe', fontSize: 11, marginTop: 2 },
  takeMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingVertical: 12,
  },
  takeMoreText: { fontWeight: '700', color: '#0f172a', fontSize: 13 },
  section: { marginTop: 18, marginBottom: 8, fontWeight: '800', color: '#334155' },
  empty: { color: '#64748b', marginTop: 12 },
  txCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 10,
  },
  txTitle: { fontSize: 13, fontWeight: '800', color: '#0f172a' },
  txRow: { marginTop: 6, fontSize: 12, color: '#334155' },
});
