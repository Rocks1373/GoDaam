import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { getPickedOrderDetail, type PickedTransactionRow } from '../api/pickedOrdersApi';

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

  const load = useCallback(async () => {
    setErr('');
    setLoading(true);
    try {
      const data = await getPickedOrderDetail(orderId);
      setPicked((data.picked_order || null) as Record<string, unknown> | null);
      setOrder((data.order || null) as Record<string, unknown> | null);
      setTx(Array.isArray(data.picked_transactions) ? data.picked_transactions : []);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error;
      setErr(msg || (e as Error).message || 'Failed to load');
      setPicked(null);
      setOrder(null);
      setTx([]);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const delivery = fmt(picked?.delivery || order?.delivery || order?.outbound_number || orderId);
    navigation.setOptions({ title: `Picked ${delivery}` });
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
        <Text style={styles.h}>Picked order</Text>
        <Text style={styles.row}>Delivery: {fmt(picked?.delivery || order?.delivery || order?.outbound_number)}</Text>
        <Text style={styles.row}>Sales Doc: {fmt(picked?.sales_doc || order?.sales_doc || order?.sales_order_number)}</Text>
        <Text style={styles.row}>Customer Ref: {fmt(picked?.customer_reference || order?.customer_reference)}</Text>
        <Text style={styles.row}>Status: {fmt(order?.status || 'Picked')}</Text>
        <Text style={styles.row}>Picked by: {pickedBy}</Text>
        <Text style={styles.row}>Confirmed by: {fmt(picked?.confirmed_by_user_name)}</Text>
        <Text style={styles.row}>Confirmed at: {fmt(picked?.confirmed_at)}</Text>
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
  h: { fontSize: 16, fontWeight: '900', color: '#0f172a', marginBottom: 8 },
  row: { fontSize: 12, color: '#334155', marginTop: 6 },
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

