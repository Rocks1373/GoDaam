import { useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { listOrders } from '../api/ordersApi';

type Props = NativeStackScreenProps<RootStackParamList, 'Orders'>;

export default function OrdersScreen({ navigation }: Props) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const data = await listOrders();
      setRows(data);
    } catch {
      setRows([]);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <View style={styles.wrap}>
      <Text style={styles.h}>Orders</Text>
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
            <Text style={styles.cardTitle}>{String(item.delivery || item.outbound_number)}</Text>
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
  wrap: { flex: 1, backgroundColor: '#f8fafc', paddingTop: 48, paddingHorizontal: 16 },
  h: { fontSize: 22, fontWeight: '800', marginBottom: 12, color: '#0f172a' },
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
