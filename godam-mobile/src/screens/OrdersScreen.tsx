import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import type { RootStackParamList } from './LoginScreen';
import { listOrders } from '../api/ordersApi';

type Props = NativeStackScreenProps<RootStackParamList, 'Orders'>;

function isUnseen(row: Record<string, unknown>): boolean {
  const v = row.order_seen;
  if (v === true || v === 1 || v === '1') return false;
  return true;
}

export default function OrdersScreen({ navigation }: Props) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const unseenCount = useMemo(() => rows.filter((r) => isUnseen(r)).length, [rows]);

  const load = async () => {
    try {
      const data = await listOrders();
      setRows(data);
    } catch {
      setRows([]);
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
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>{String(item.delivery || item.outbound_number)}</Text>
              {isUnseen(item) ? (
                <View style={styles.newPill}>
                  <Text style={styles.newPillText}>NEW</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.cardSub}>
              {String(item.sales_doc || item.sales_order_number || '')} · {String(item.status)}
            </Text>
            <Text style={styles.cardSub}>
              Progress {String(item.total_picked ?? 0)} / {String(item.total_required ?? 0)}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No open pick orders.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', paddingTop: 12, paddingHorizontal: 16 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
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
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  cardSub: { fontSize: 12, color: '#64748b', marginTop: 4 },
  empty: { color: '#94a3b8', marginTop: 24 },
});
