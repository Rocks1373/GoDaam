import { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { api } from '../api/client';

export default function UpcomingOrdersScreen() {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/mobile/upcoming');
      setRows(res.data as Record<string, unknown>[]);
    } catch {
      setRows([]);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <View style={styles.wrap}>
      <Text style={styles.h}>Upcoming Orders</Text>
      <FlatList
        data={rows}
        keyExtractor={(item) => String(item.id)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load().finally(() => setRefreshing(false));
            }}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.t}>{String(item.delivery || item.outbound_number)}</Text>
            <Text style={styles.s}>{String(item.status)}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No upcoming rows.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', paddingTop: 48, paddingHorizontal: 16 },
  h: { fontSize: 22, fontWeight: '800', marginBottom: 12 },
  card: {
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  t: { fontWeight: '700', color: '#0f172a' },
  s: { fontSize: 12, color: '#64748b', marginTop: 4 },
  empty: { color: '#94a3b8', marginTop: 24 },
});
