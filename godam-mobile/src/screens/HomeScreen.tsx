import { useEffect, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { me } from '../api/authApi';
import { registerDevice } from '../api/notificationsApi';
import { listOrders } from '../api/ordersApi';
import { shouldSkipExpoNotifications, tryConfigurePushNotifications } from '../utils/expoPushSafe';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const [userLabel, setUserLabel] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const [orderHint, setOrderHint] = useState('—');
  const [pushNote, setPushNote] = useState('');

  useEffect(() => {
    setPushNote(
      shouldSkipExpoNotifications()
        ? 'Alerts: use a dev build for push on Android (Expo Go limitation).'
        : 'Alerts: push when permission granted.'
    );
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { user } = await me();
        setUserLabel(user.full_name || user.username);
        setRoleLabel(user.role);
        await tryConfigurePushNotifications(registerDevice);
      } catch {
        setUserLabel('');
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listOrders();
        if (!cancelled) setOrderHint(String(data?.length ?? 0));
      } catch {
        if (!cancelled) setOrderHint('—');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const NavBtn = ({ title, onPress }: { title: string; onPress: () => void }) => (
    <Pressable style={styles.big} onPress={onPress}>
      <Text style={styles.bigText}>{title}</Text>
    </Pressable>
  );

  return (
    <View style={styles.wrap}>
      <Image source={require('../../assets/icon.png')} style={styles.brandLogo} resizeMode="contain" accessibilityLabel="GoDaam" />
      <Text style={styles.meta}>
        {userLabel || '…'} · {roleLabel || '…'}
      </Text>
      <Text style={styles.meta}>Sync: OK · Assigned orders: {orderHint}</Text>
      <Text style={styles.alert}>{pushNote}</Text>

      <NavBtn title="Orders" onPress={() => navigation.navigate('Orders')} />
      <NavBtn title="Scan Rack" onPress={() => navigation.navigate('ScanRack')} />
      <NavBtn title="Receiving" onPress={() => navigation.navigate('Receiving')} />
      <NavBtn title="Upcoming Orders" onPress={() => navigation.navigate('Upcoming')} />
      <Pressable style={styles.link} onPress={() => navigation.navigate('Profile')}>
        <Text style={styles.linkText}>Profile / Logout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 20, paddingTop: 56, backgroundColor: '#f8fafc' },
  brandLogo: { width: 160, height: 88, marginBottom: 8, alignSelf: 'flex-start' },
  meta: { fontSize: 12, color: '#475569', marginTop: 6 },
  alert: { fontSize: 11, color: '#b45309', marginBottom: 16 },
  big: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    elevation: 1,
  },
  bigText: { fontSize: 16, fontWeight: '700', color: '#1e293b' },
  link: { marginTop: 8 },
  linkText: { color: '#2563eb', fontWeight: '600' },
});
