import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { me } from '../api/authApi';
import { registerDevice } from '../api/notificationsApi';
import { listOrders } from '../api/ordersApi';
import { shouldSkipExpoNotifications, tryConfigurePushNotifications } from '../utils/expoPushSafe';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type QuickActionRoute = 'Orders' | 'ScanRack' | 'Receiving' | 'Upcoming';

type ActionItem = {
  key: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: QuickActionRoute;
};

const ACTIONS: ActionItem[] = [
  {
    key: 'orders',
    title: 'Orders',
    subtitle: 'Assigned & pick lists',
    icon: 'clipboard-outline',
    route: 'Orders',
  },
  {
    key: 'scan',
    title: 'Scan Rack',
    subtitle: 'Locate by barcode',
    icon: 'barcode-outline',
    route: 'ScanRack',
  },
  {
    key: 'receiving',
    title: 'Receiving',
    subtitle: 'Inbound & putaway',
    icon: 'cube-outline',
    route: 'Receiving',
  },
  {
    key: 'upcoming',
    title: 'Upcoming Orders',
    subtitle: 'Plan ahead',
    icon: 'calendar-outline',
    route: 'Upcoming',
  },
];

export default function HomeScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
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

  const greetingName = useMemo(() => {
    const raw = userLabel.trim();
    if (!raw) return 'there';
    return raw.split(/\s+/)[0] ?? 'there';
  }, [userLabel]);

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom, 20) + 8 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <Image
              source={require('../../assets/icon.png')}
              style={styles.brandMark}
              resizeMode="contain"
              accessibilityLabel="GoDaam"
            />
            <View style={styles.heroTitles}>
              <Text style={styles.eyebrow}>Warehouse</Text>
              <Text style={styles.title}>GoDaam</Text>
            </View>
          </View>
          <Text style={styles.greeting}>
            Hello, <Text style={styles.greetingAccent}>{greetingName}</Text>
          </Text>
          <View style={styles.roleRow}>
            <View style={styles.rolePill}>
              <Ionicons name="shield-checkmark-outline" size={14} color="#1d4ed8" />
              <Text style={styles.roleText} numberOfLines={1}>
                {roleLabel || '…'}
              </Text>
            </View>
            <Text style={styles.emailHint} numberOfLines={1}>
              {userLabel || 'Loading profile…'}
            </Text>
          </View>
        </View>

        <View style={styles.statsCard}>
          <View style={styles.statCell}>
            <View style={styles.statIconWrap}>
              <Ionicons name="sync-outline" size={20} color="#1d4ed8" />
            </View>
            <View>
              <Text style={styles.statLabel}>Sync</Text>
              <Text style={styles.statValue}>Connected</Text>
            </View>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statCell}>
            <View style={styles.statIconWrap}>
              <Ionicons name="layers-outline" size={20} color="#1d4ed8" />
            </View>
            <View>
              <Text style={styles.statLabel}>Assigned orders</Text>
              <Text style={styles.statValue}>{orderHint}</Text>
            </View>
          </View>
        </View>

        <View style={styles.alertBanner}>
          <Ionicons name="notifications-outline" size={18} color="#b45309" />
          <Text style={styles.alertText}>{pushNote}</Text>
        </View>

        <Text style={styles.sectionLabel}>Quick actions</Text>
        <View style={styles.grid}>
          {[0, 2].map((start) => (
            <View key={start} style={styles.gridRow}>
              {ACTIONS.slice(start, start + 2).map((item) => (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  onPress={() => navigation.navigate(item.route)}
                  accessibilityRole="button"
                  accessibilityLabel={item.title}
                >
                  <View style={styles.tileIconCircle}>
                    <Ionicons name={item.icon} size={26} color="#1d4ed8" />
                  </View>
                  <Text style={styles.tileTitle}>{item.title}</Text>
                  <Text style={styles.tileSub}>{item.subtitle}</Text>
                  <Ionicons name="chevron-forward" size={18} color="#94a3b8" style={styles.tileChevron} />
                </Pressable>
              ))}
            </View>
          ))}
        </View>

        <Pressable
          style={({ pressed }) => [styles.profileCard, pressed && styles.tilePressed]}
          onPress={() => navigation.navigate('Profile')}
          accessibilityRole="button"
          accessibilityLabel="Profile and logout"
        >
          <View style={styles.profileLeft}>
            <View style={styles.profileAvatar}>
              <Ionicons name="person-outline" size={22} color="#1d4ed8" />
            </View>
            <View>
              <Text style={styles.profileTitle}>Profile</Text>
              <Text style={styles.profileSub}>Account & logout</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#64748b" />
        </Pressable>
      </ScrollView>
    </View>
  );
}

const shadowCard = Platform.select({
  ios: {
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
  },
  android: { elevation: 3 },
  default: {},
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8 },
  hero: { marginBottom: 20 },
  heroTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  brandMark: { width: 48, height: 48, borderRadius: 12 },
  heroTitles: { marginLeft: 12, justifyContent: 'center' },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: '#64748b',
  },
  title: { fontSize: 22, fontWeight: '800', color: '#0f172a', letterSpacing: -0.5 },
  greeting: { fontSize: 26, fontWeight: '700', color: '#0f172a', letterSpacing: -0.3 },
  greetingAccent: { color: '#1d4ed8' },
  roleRow: { marginTop: 10, gap: 8 },
  rolePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  roleText: { fontSize: 13, fontWeight: '600', color: '#1e3a8a', maxWidth: 280 },
  emailHint: { fontSize: 13, color: '#64748b' },
  statsCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...shadowCard,
  },
  statCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  statDivider: { width: 1, backgroundColor: '#e2e8f0', marginHorizontal: 4 },
  statIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statLabel: { fontSize: 11, fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.6 },
  statValue: { fontSize: 17, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#fffbeb',
    borderRadius: 12,
    padding: 12,
    marginBottom: 22,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  alertText: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 17 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  grid: { gap: 12 },
  gridRow: { flexDirection: 'row', gap: 12 },
  tile: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    paddingRight: 36,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...shadowCard,
  },
  tilePressed: { opacity: 0.92 },
  tileIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  tileTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  tileSub: { fontSize: 12, color: '#64748b', marginTop: 4, lineHeight: 16 },
  tileChevron: { position: 'absolute', right: 12, top: 18 },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    ...shadowCard,
  },
  profileLeft: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  profileAvatar: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#eff6ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  profileSub: { fontSize: 13, color: '#64748b', marginTop: 2 },
});
