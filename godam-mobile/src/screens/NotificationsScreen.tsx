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
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type NotificationRow,
} from '../api/notificationsApi';

type Props = NativeStackScreenProps<RootStackParamList, 'Notifications'>;

function parseData(d: string | null | undefined): Record<string, unknown> | null {
  if (!d) return null;
  try {
    return JSON.parse(d) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export default function NotificationsScreen({ navigation }: Props) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listNotifications(false);
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !rows.length) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1d4ed8" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.toolbar}>
        <Text style={styles.h}>Notifications</Text>
        <Pressable
          style={({ pressed }) => [styles.markAll, pressed && { opacity: 0.8 }]}
          onPress={async () => {
            try {
              await markAllNotificationsRead();
              await load();
            } catch {
              // ignore
            }
          }}
        >
          <Text style={styles.markAllText}>Mark all read</Text>
        </Pressable>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<Text style={styles.empty}>No notifications yet.</Text>}
        renderItem={({ item }) => {
          const unread = !item.read_at;
          const data = parseData(item.data_json);
          const orderId = typeof data?.outbound_order_id === 'number' ? data.outbound_order_id : null;
          const taskId = typeof data?.task_id === 'number' ? data.task_id : null;
          return (
            <Pressable
              style={({ pressed }) => [styles.card, unread && styles.cardUnread, pressed && { opacity: 0.92 }]}
              onPress={async () => {
                try {
                  if (unread) await markNotificationRead(item.id);
                  if (orderId) {
                    navigation.navigate('OrderDetail', { orderId });
                    return;
                  }
                  // Delivery notifications deep-link to the driver task view (created by /api/delivery-notes/:id/confirm).
                  if (taskId) {
                    navigation.navigate('DeliveryDetail', { taskId });
                    return;
                  } else {
                    await load();
                  }
                } catch {
                  // ignore
                }
              }}
            >
              <View style={styles.cardTop}>
                <Ionicons
                  name={unread ? 'notifications' : 'notifications-outline'}
                  size={20}
                  color={unread ? '#1d4ed8' : '#94a3b8'}
                />
                <Text style={styles.title} numberOfLines={2}>
                  {item.title || 'GoDaam'}
                </Text>
              </View>
              {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
              <Text style={styles.meta}>
                {item.created_at ? String(item.created_at) : ''}
                {unread ? ' · Unread' : ''}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8fafc' },
  toolbar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  h: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  markAll: { paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#eff6ff', borderRadius: 8 },
  markAllText: { fontSize: 12, fontWeight: '700', color: '#1d4ed8' },
  card: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardUnread: { borderColor: '#93c5fd', backgroundColor: '#f8fafc' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  title: { flex: 1, fontSize: 15, fontWeight: '700', color: '#0f172a' },
  body: { fontSize: 13, color: '#475569', lineHeight: 18, marginTop: 4 },
  meta: { fontSize: 11, color: '#94a3b8', marginTop: 8 },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 40, paddingHorizontal: 24 },
});
