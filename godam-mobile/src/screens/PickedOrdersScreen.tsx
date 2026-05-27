import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  RefreshControl,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { listPickedOrders, type PickedOrderRow } from '../api/pickedOrdersApi';
import { formatApiError } from '../api/client';
import { OrderIdentityLabels } from '../components/OrderIdentityLabels';

type Props = NativeStackScreenProps<RootStackParamList, 'PickedOrders'>;

function norm(s: unknown) {
  return String(s ?? '').trim().toLowerCase();
}

export default function PickedOrdersScreen({ navigation }: Props) {
  const [rows, setRows] = useState<PickedOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await listPickedOrders(200);
      setRows(Array.isArray(data) ? data : []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(formatApiError(e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await load();
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  const filtered = useMemo(() => {
    const qq = norm(q);
    if (!qq) return rows;
    return rows.filter((r) => {
      const hay = [
        r.order_id,
        r.delivery,
        r.sales_doc,
        r.customer_reference,
        r.sold_to,
        r.name_1,
        r.customer_name,
        r.outbound_number,
        r.confirmed_by_user_name,
        r.picked_by_names,
        r.order_status,
      ]
        .filter(Boolean)
        .join(' ');
      return norm(hay).includes(qq);
    });
  }, [rows, q]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: filtered.length ? `Picked orders (${filtered.length})` : 'Picked orders' });
  }, [navigation, filtered.length]);

  return (
    <View style={styles.wrap}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          value={q}
          onChangeText={setQ}
          placeholder="Search customer, outbound, sales doc, picker..."
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {loadErr ? (
        <View style={styles.errBanner}>
          <Text style={styles.errText}>{loadErr}</Text>
          <Pressable onPress={() => void load()}>
            <Text style={styles.errRetry}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {loading && !rows.length ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.order_id)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={<Text style={styles.empty}>No picked orders.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
            onPress={() => navigation.navigate('PickedOrderDetail', { orderId: Number(item.order_id) })}
          >
            <View style={styles.rowTop}>
              <View style={{ flex: 1 }}>
                <OrderIdentityLabels
                  item={{
                    ...item,
                    outbound_number: item.outbound_number || item.delivery,
                    customer_name: item.customer_name || item.name_1,
                  }}
                  meta={`Sales Doc: ${String(item.sales_doc || '—')} · Ref: ${String(item.customer_reference || '—')}`}
                />
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{String(item.order_status || 'Picked')}</Text>
              </View>
            </View>
            <Text style={styles.sub} numberOfLines={1}>
              Picked by: {String(item.picked_by_names || '—')}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              Confirmed by: {String(item.confirmed_by_user_name || '—')}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc' },
  errBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  errText: { flex: 1, fontSize: 11, color: '#991b1b' },
  errRetry: { fontSize: 12, fontWeight: '700', color: '#2563eb' },
  searchRow: { padding: 16, paddingBottom: 8 },
  search: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0f172a',
  },
  empty: { textAlign: 'center', color: '#64748b', marginTop: 40 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  badge: { backgroundColor: '#eff6ff', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeText: { color: '#1d4ed8', fontWeight: '800', fontSize: 11 },
  sub: { marginTop: 6, color: '#334155', fontSize: 12 },
});

