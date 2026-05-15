import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { me } from '../api/authApi';
import { registerDevice } from '../api/notificationsApi';
import { getMobileSummary, listOrders } from '../api/ordersApi';
import { shouldSkipExpoNotifications, tryConfigurePushNotifications } from '../utils/expoPushSafe';
import { useTheme } from '../theme/ThemeContext';
import type { ThemeDefinition } from '../theme/palettes';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type QuickActionRoute =
  | 'Orders'
  | 'ScanRack'
  | 'Receiving'
  | 'Upcoming'
  | 'MainStockCheck'
  | 'StockByRackCheck'
  | 'DeliveryList';

type ActionItem = {
  key: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: QuickActionRoute;
  badge?: number;
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
    key: 'delivery',
    title: 'Delivery',
    subtitle: 'GAPP confirmed orders',
    icon: 'car-outline',
    route: 'DeliveryList',
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
  {
    key: 'mainStock',
    title: 'Check Main Stock',
    subtitle: 'View only · by part #',
    icon: 'albums-outline',
    route: 'MainStockCheck',
  },
  {
    key: 'stockByRack',
    title: 'Stock by rack',
    subtitle: 'View only · part & rack',
    icon: 'grid-outline',
    route: 'StockByRackCheck',
  },
];

export default function HomeScreen({ navigation }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => createHomeStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const rootNav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [userLabel, setUserLabel] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const [orderTotal, setOrderTotal] = useState(0);
  const [summary, setSummary] = useState({
    notifications_unread: 0,
    orders_unseen: 0,
    inbound_putaway_pending: 0,
    notif_unread_orders: 0,
    notif_unread_delivery: 0,
    notif_unread_inbound: 0,
    notif_unread_picked: 0,
  });
  const [pushNote, setPushNote] = useState('');
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

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
        setPerms(user.permissions || {});
        setPermissionsLoaded(true);
        await tryConfigurePushNotifications(registerDevice);
      } catch {
        setUserLabel('');
      }
    })();
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([getMobileSummary(), listOrders().catch(() => [])]);
      setSummary(s);
      setOrderTotal(Array.isArray(list) ? list.length : 0);
    } catch {
      setSummary({
        notifications_unread: 0,
        orders_unseen: 0,
        inbound_putaway_pending: 0,
        notif_unread_orders: 0,
        notif_unread_delivery: 0,
        notif_unread_inbound: 0,
        notif_unread_picked: 0,
      });
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const run = async () => {
        if (!alive) return;
        await refreshSummary();
      };
      void run();
      const t = setInterval(() => void run(), 25000);
      return () => {
        alive = false;
        clearInterval(t);
      };
    }, [refreshSummary])
  );

  useEffect(() => {
    let sub: { remove: () => void } | undefined;
    let cancelled = false;
    void (async () => {
      if (shouldSkipExpoNotifications()) return;
      try {
        const Notifications = await import('expo-notifications');
        if (cancelled) return;
        sub = Notifications.addNotificationReceivedListener(() => {
          void refreshSummary();
        });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [refreshSummary]);

  useLayoutEffect(() => {
    const n = summary.notifications_unread;
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => rootNav.navigate('Notifications')}
          style={({ pressed }) => [
            { marginRight: 4, padding: 8, position: 'relative' as const },
            pressed && { opacity: 0.75 },
          ]}
          accessibilityLabel={`Notifications${n > 0 ? `, ${n} unread` : ''}`}
        >
          <Ionicons name="notifications-outline" size={24} color={palette.headerTitle} />
          {n > 0 ? (
            <View style={styles.notifBadge}>
              <Text style={styles.notifBadgeText}>{n > 99 ? '99+' : String(n)}</Text>
            </View>
          ) : null}
        </Pressable>
      ),
    });
  }, [navigation, rootNav, summary.notifications_unread, palette.headerTitle]);

  const greetingName = useMemo(() => {
    const raw = userLabel.trim();
    if (!raw) return 'there';
    return raw.split(/\s+/)[0] ?? 'there';
  }, [userLabel]);

  const visibleActions = useMemo(() => {
    return ACTIONS.filter((item) => {
      if (item.key === 'delivery') {
        if (!permissionsLoaded) return false;
        const r = String(roleLabel || '').toLowerCase();
        return r === 'driver' || r === 'admin' || !!perms.can_confirm_picked;
      }
      if (item.key === 'mainStock') {
        if (!permissionsLoaded) return true;
        return !!(perms.can_pick_orders || perms.can_view_main_stock);
      }
      if (item.key === 'stockByRack') {
        if (!permissionsLoaded) return true;
        return !!(perms.can_pick_orders || perms.can_view_stock_by_rack);
      }
      return true;
    });
  }, [perms, permissionsLoaded, roleLabel]);

  const actionItems = useMemo(() => {
    const pickAlerts = summary.orders_unseen + (summary.notif_unread_orders ?? 0);
    const deliveryAlerts = summary.notif_unread_delivery ?? 0;
    const recvAlerts = summary.inbound_putaway_pending + (summary.notif_unread_inbound ?? 0);
    return visibleActions.map((item) => {
      if (item.key === 'orders') {
        return {
          ...item,
          badge: pickAlerts,
          subtitle:
            pickAlerts > 0
              ? `${summary.orders_unseen} queue not opened · ${summary.notif_unread_orders ?? 0} unread alerts`
              : item.subtitle,
        };
      }
      if (item.key === 'delivery') {
        return {
          ...item,
          badge: deliveryAlerts,
          subtitle:
            deliveryAlerts > 0 ? `${deliveryAlerts} unread delivery alerts` : item.subtitle,
        };
      }
      if (item.key === 'receiving') {
        return {
          ...item,
          badge: recvAlerts,
          subtitle:
            summary.inbound_putaway_pending > 0
              ? `${summary.inbound_putaway_pending} batch(es) need putaway · Inbound & putaway`
              : item.subtitle,
        };
      }
      return { ...item, badge: 0 };
    });
  }, [
    visibleActions,
    summary.orders_unseen,
    summary.inbound_putaway_pending,
    summary.notif_unread_orders,
    summary.notif_unread_delivery,
    summary.notif_unread_inbound,
  ]);

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
              <Ionicons name="shield-checkmark-outline" size={14} color={palette.primaryHover} />
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
              <Ionicons name="sync-outline" size={20} color={palette.primaryHover} />
            </View>
            <View>
              <Text style={styles.statLabel}>Sync</Text>
              <Text style={styles.statValue}>Connected</Text>
            </View>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statCell}>
            <View style={styles.statIconWrap}>
              <Ionicons name="layers-outline" size={20} color={palette.primaryHover} />
            </View>
            <View>
              <Text style={styles.statLabel}>Assigned orders</Text>
              <Text style={styles.statValue}>{orderTotal}</Text>
              {summary.orders_unseen + (summary.notif_unread_orders ?? 0) > 0 ? (
                <Text style={styles.statNewHint}>
                  {summary.orders_unseen} new to open · {summary.notif_unread_orders ?? 0} alerts
                </Text>
              ) : null}
            </View>
          </View>
        </View>

        <View style={styles.alertBanner}>
          <Ionicons name="notifications-outline" size={18} color={palette.warningText} />
          <Text style={styles.alertText}>{pushNote}</Text>
        </View>

        <Text style={styles.sectionLabel}>Quick actions</Text>
        <View style={styles.grid}>
          {Array.from({ length: Math.ceil(actionItems.length / 2) }, (_, i) => i * 2).map((start) => (
            <View key={start} style={styles.gridRow}>
              {actionItems.slice(start, start + 2).map((item) => (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
                  onPress={() => navigation.navigate(item.route)}
                  accessibilityRole="button"
                  accessibilityLabel={item.title}
                >
                  <View style={styles.tileIconCircle}>
                    <Ionicons name={item.icon} size={26} color={palette.primaryHover} />
                  </View>
                  <View style={styles.tileTitleRow}>
                    <Text style={styles.tileTitle}>{item.title}</Text>
                    {typeof item.badge === 'number' && item.badge > 0 ? (
                      <View style={styles.tileInlineBadge}>
                        <Text style={styles.tileInlineBadgeText}>
                          {item.badge > 99 ? '99+' : String(item.badge)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.tileSub}>{item.subtitle}</Text>
                  <Ionicons name="chevron-forward" size={18} color={palette.iconMuted} style={styles.tileChevron} />
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
              <Ionicons name="person-outline" size={22} color={palette.primaryHover} />
            </View>
            <View>
              <Text style={styles.profileTitle}>Profile</Text>
              <Text style={styles.profileSub}>Account & logout</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color={palette.iconMuted} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

function createHomeStyles(c: ThemeDefinition) {
  const shadowCard = Platform.select({
    ios: {
      shadowColor: c.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.07,
      shadowRadius: 12,
    },
    android: { elevation: 3 },
    default: {},
  });

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background },
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
      color: c.textMuted,
    },
    title: { fontSize: 22, fontWeight: '800', color: c.text, letterSpacing: -0.5 },
    greeting: { fontSize: 26, fontWeight: '700', color: c.text, letterSpacing: -0.3 },
    greetingAccent: { color: c.primaryHover },
    roleRow: { marginTop: 10, gap: 8 },
    rolePill: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      backgroundColor: c.primarySoft,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.primaryBorder,
    },
    roleText: { fontSize: 13, fontWeight: '600', color: c.pillText, maxWidth: 280 },
    emailHint: { fontSize: 13, color: c.textMuted },
    statsCard: {
      flexDirection: 'row',
      alignItems: 'stretch',
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 16,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: c.border,
      ...shadowCard,
    },
    statCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
    statDivider: { width: 1, backgroundColor: c.border, marginHorizontal: 4 },
    statIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.tileIconBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statLabel: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    statValue: { fontSize: 17, fontWeight: '700', color: c.text, marginTop: 2 },
    statNewHint: { fontSize: 12, fontWeight: '600', color: c.warningText, marginTop: 4 },
    notifBadge: {
      position: 'absolute',
      right: -2,
      top: -4,
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: c.danger,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
    },
    notifBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
    alertBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      backgroundColor: c.warningBg,
      borderRadius: 12,
      padding: 12,
      marginBottom: 22,
      borderWidth: 1,
      borderColor: c.warningBorder,
    },
    alertText: { flex: 1, fontSize: 12, color: c.warningText, lineHeight: 17 },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textSecondary,
      marginBottom: 12,
      letterSpacing: 0.3,
    },
    grid: { gap: 12 },
    gridRow: { flexDirection: 'row', gap: 12 },
    tile: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 16,
      paddingRight: 36,
      borderWidth: 1,
      borderColor: c.border,
      ...shadowCard,
    },
    tilePressed: { opacity: 0.92 },
    tileTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    tileInlineBadge: {
      minWidth: 22,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: 11,
      backgroundColor: c.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileInlineBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
    tileIconCircle: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: c.tileIconBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
    },
    tileTitle: { fontSize: 16, fontWeight: '700', color: c.text },
    tileSub: { fontSize: 12, color: c.textMuted, marginTop: 4, lineHeight: 16 },
    tileChevron: { position: 'absolute', right: 12, top: 18 },
    profileCard: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 16,
      marginTop: 16,
      borderWidth: 1,
      borderColor: c.border,
      ...shadowCard,
    },
    profileLeft: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    profileAvatar: {
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: c.tileIconBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    profileTitle: { fontSize: 16, fontWeight: '700', color: c.text },
    profileSub: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  });
}
