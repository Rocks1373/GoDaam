import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { listDeliveries, type DriverDeliveryTask } from '../api/deliveriesApi';
import { listActiveDriverDeliveries } from '../api/driverRoutesApi';

type Props = NativeStackScreenProps<RootStackParamList, 'DeliveryList'>;

export default function DeliveryListScreen({ navigation }: Props) {
  const [rows, setRows] = useState<DriverDeliveryTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const [activeCount, setActiveCount] = useState<number | null>(null);

  const load = useCallback(async (isPull = false) => {
    setErr('');
    if (isPull) setRefreshing(true);
    else setLoading(true);
    try {
      const [data, active] = await Promise.all([
        listDeliveries(),
        listActiveDriverDeliveries().catch(() => []),
      ]);
      setRows(Array.isArray(data) ? data : []);
      setActiveCount(Array.isArray(active) ? active.length : 0);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error;
      setErr(msg || (e as Error).message || 'Failed to load');
      setRows([]);
      setActiveCount(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.screen}>
      {err ? <Text style={styles.err}>{err}</Text> : null}
      <View style={styles.topPad}>
        <Pressable
          style={({ pressed }) => [styles.routeBtn, pressed && { opacity: 0.92 }]}
          onPress={() => navigation.navigate('RoutePlanner')}
        >
          <Text style={styles.routeBtnText}>
            Show Route{activeCount != null ? ` (${activeCount})` : ''}
          </Text>
        </Pressable>
        <Text style={styles.hint}>
          If you have one active delivery, open it to navigate. If you have multiple, use Route Planner.
        </Text>
      </View>
      {loading && !rows.length ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
          ListEmptyComponent={<Text style={styles.empty}>No delivery tasks.</Text>}
          contentContainerStyle={styles.listPad}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
              onPress={() => navigation.navigate('DeliveryDetail', { taskId: item.id })}
            >
              <Text style={styles.ob}>{item.outbound_number || '—'}</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {item.customer_name || '—'}
              </Text>
              <Text style={styles.city} numberOfLines={1}>
                {item.city_name || ''}
              </Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{item.status || '—'}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9' },
  topPad: { padding: 16, paddingBottom: 0 },
  routeBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  routeBtnText: { color: '#fff', fontWeight: '900' },
  hint: { marginTop: 8, fontSize: 12, color: '#64748b' },
  listPad: { padding: 16, paddingBottom: 32 },
  err: { color: '#b91c1c', padding: 16, fontSize: 13 },
  empty: { textAlign: 'center', color: '#64748b', marginTop: 40 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  ob: { fontSize: 17, fontWeight: '800', color: '#0f172a' },
  sub: { fontSize: 14, color: '#334155', marginTop: 4 },
  city: { fontSize: 12, color: '#64748b', marginTop: 2 },
  badge: {
    alignSelf: 'flex-start',
    marginTop: 10,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#1d4ed8' },
});
