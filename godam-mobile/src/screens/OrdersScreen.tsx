import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import type { RootStackParamList } from './LoginScreen';
import { listOrders } from '../api/ordersApi';
import { formatApiError } from '../api/client';
import { OrderIdentityLabels } from '../components/OrderIdentityLabels';

type Props = NativeStackScreenProps<RootStackParamList, 'Orders'>;

function isUnseen(row: Record<string, unknown>): boolean {
  const v = row.order_seen;
  if (v === true || v === 1 || v === '1') return false;
  return true;
}

export default function OrdersScreen({ navigation }: Props) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const unseenCount = useMemo(() => rows.filter((r) => isUnseen(r)).length, [rows]);

  const load = async () => {
    try {
      const data = await listOrders();
      setRows(data);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(formatApiError(e));
    }
  };

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [])
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: unseenCount > 0 ? `Orders (${unseenCount})` : 'Orders',
    });
  }, [navigation, unseenCount]);

  return (
    <View style={styles.wrap}>
      {loadErr ? (
        <View style={styles.errBanner}>
          <Text style={styles.errText}>{loadErr}</Text>
          <Pressable onPress={() => void load()}>
            <Text style={styles.errRetry}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(item) => String(item.id)}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          load().finally(() => setRefreshing(false));
        }}
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => navigation.navigate('OrderDetail', { orderId: Number(item.id) })}
          >
            <OrderIdentityLabels
              item={item}
              meta={`${String(item.sales_doc || item.sales_order_number || '—')} · ${String(item.status)} · Pick ${String(item.total_picked ?? 0)} / ${String(item.total_required ?? 0)}`}
              titleRight={
                isUnseen(item) ? (
                  <View style={styles.newPill}>
                    <Text style={styles.newPillText}>NEW</Text>
                  </View>
                ) : null
              }
            />
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {loadErr ? 'Could not load orders. Tap Retry above or pull to refresh.' : 'No open pick orders.'}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', paddingTop: 12, paddingHorizontal: 16 },
  errBanner: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  errText: { flex: 1, fontSize: 11, color: '#991b1b' },
  errRetry: { fontSize: 12, fontWeight: '700', color: '#2563eb' },
  newPill: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  newPillText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  empty: { color: '#94a3b8', marginTop: 24 },
});
