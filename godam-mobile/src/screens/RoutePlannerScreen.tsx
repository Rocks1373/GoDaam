import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
  Linking,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import {
  autoSortNearest,
  getCurrentRoute,
  type DriverRouteStop,
} from '../api/driverRoutesApi';
import { saveManualSequence } from '../api/driverRoutesApi';
import { googleMapsMultiStopUrls, googleMapsSingleDestinationUrl, type LatLng } from '../utils/mapsUrl';

type Props = NativeStackScreenProps<RootStackParamList, 'RoutePlanner'>;

function toLatLng(s: DriverRouteStop): LatLng | null {
  const lat = s.latitude != null ? Number(s.latitude) : NaN;
  const lng = s.longitude != null ? Number(s.longitude) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng };
}

function hasGps(s: DriverRouteStop): boolean {
  return !!toLatLng(s) || !!String(s.gps_link || '').trim();
}

export default function RoutePlannerScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [rows, setRows] = useState<DriverRouteStop[]>([]);
  const [seqDraft, setSeqDraft] = useState<Record<string, string>>({});
  const [origin, setOrigin] = useState<LatLng | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = await getCurrentRoute().catch(() => []);
      setRows(Array.isArray(current) ? current : []);
      setWarning(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Seed draft from current sequence
    const next: Record<string, string> = {};
    for (const r of rows) {
      next[String(r.driver_delivery_task_id)] = r.sequence_no != null ? String(r.sequence_no) : '';
    }
    setSeqDraft(next);
  }, [rows]);

  const orderedRows = useMemo(() => {
    const list = [...rows];
    list.sort((a, b) => (Number(a.sequence_no) || 999999) - (Number(b.sequence_no) || 999999));
    return list;
  }, [rows]);

  const gpsMissingCount = useMemo(() => orderedRows.filter((r) => !toLatLng(r)).length, [orderedRows]);

  const onAutoSort = async () => {
    setBusy(true);
    try {
      const res = await autoSortNearest({});
      setRows(res.stops || []);
      setOrigin(res.origin || null);
      setWarning(res.warning || null);
      if (res.warning) Alert.alert('Route warning', res.warning);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error;
      Alert.alert('Error', msg || (e as Error).message || 'Auto sort failed');
    } finally {
      setBusy(false);
    }
  };

  const onMove = (taskId: number, dir: -1 | 1) => {
    const list = [...orderedRows];
    const idx = list.findIndex((x) => Number(x.driver_delivery_task_id) === Number(taskId));
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[idx];
    const b = list[j];
    const aSeq = seqDraft[String(a.driver_delivery_task_id)] || '';
    const bSeq = seqDraft[String(b.driver_delivery_task_id)] || '';
    setSeqDraft((s) => ({
      ...s,
      [String(a.driver_delivery_task_id)]: bSeq,
      [String(b.driver_delivery_task_id)]: aSeq,
    }));
  };

  const onOpenIndividual = async (stop: DriverRouteStop) => {
    const ll = toLatLng(stop);
    if (ll) {
      const url = googleMapsSingleDestinationUrl(ll);
      await Linking.openURL(url);
      return;
    }
    const gps = String(stop.gps_link || '').trim();
    if (gps) {
      await Linking.openURL(gps.startsWith('http') ? gps : `https://maps.google.com/?q=${encodeURIComponent(gps)}`);
      return;
    }
    Alert.alert('No GPS', 'This delivery has no GPS location.');
  };

  const validateManual = () => {
    const seqs: { tid: number; seq: number }[] = [];
    for (const r of orderedRows) {
      const tid = Number(r.driver_delivery_task_id);
      const raw = (seqDraft[String(tid)] || '').trim();
      if (!raw) return { ok: false, error: 'Sequence number required for all stops.' };
      const n = Number(raw);
      if (!Number.isFinite(n) || !(n > 0)) return { ok: false, error: 'Sequence must be a positive number.' };
      seqs.push({ tid, seq: n });
    }
    const seen = new Set<number>();
    for (const s of seqs) {
      if (seen.has(s.seq)) return { ok: false, error: 'Sequence numbers must be unique.' };
      seen.add(s.seq);
    }
    seqs.sort((a, b) => a.seq - b.seq);
    return { ok: true as const, seqs };
  };

  const onSaveManual = async () => {
    const v = validateManual();
    if (!v.ok) {
      Alert.alert('Invalid sequence', v.error);
      return;
    }
    setBusy(true);
    try {
      const res = await saveManualSequence(
        v.seqs.map((s) => ({ driver_delivery_task_id: s.tid, sequence_no: s.seq }))
      );
      setRows(res.stops || []);
      Alert.alert('Saved', 'Manual sequence saved.');
    } finally {
      setBusy(false);
    }
  };

  const onOpenRoute = async () => {
    const withSeq = orderedRows.filter((r) => (Number(seqDraft[String(r.driver_delivery_task_id)]) || 0) > 0);
    if (withSeq.length !== orderedRows.length) {
      Alert.alert('Sequence required', 'Set unique sequence numbers for all stops before opening the route.');
      return;
    }

    const seqMap = new Map<number, number>();
    for (const r of orderedRows) {
      seqMap.set(Number(r.driver_delivery_task_id), Number(seqDraft[String(r.driver_delivery_task_id)]));
    }
    const sorted = [...orderedRows].sort((a, b) => (seqMap.get(Number(a.driver_delivery_task_id)) || 0) - (seqMap.get(Number(b.driver_delivery_task_id)) || 0));

    const coords = sorted.map(toLatLng).filter(Boolean) as LatLng[];
    if (coords.length === 0) {
      Alert.alert('No GPS', 'No deliveries have coordinates to build a route.');
      return;
    }
    if (coords.length === 1) {
      await Linking.openURL(googleMapsSingleDestinationUrl(coords[0]));
      return;
    }
    const o = origin || coords[0];
    const urls = googleMapsMultiStopUrls({ origin: o, stopsInOrder: coords });
    if (urls.length === 1) {
      await Linking.openURL(urls[0]);
      return;
    }
    Alert.alert(
      'Route split',
      `This route has more than 10 stops. It will open in ${urls.length} parts.`,
      urls.map((u, i) => ({ text: `Open Part ${i + 1}`, onPress: () => void Linking.openURL(u) })).concat([{ text: 'Cancel', style: 'cancel' }])
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {warning ? <Text style={styles.warn}>{warning}</Text> : null}
      {gpsMissingCount > 0 ? (
        <Text style={styles.warn}>Some deliveries have no coordinates. Auto-sort/route may skip them.</Text>
      ) : null}

      <View style={styles.toolbar}>
        <Pressable style={[styles.btn, busy && styles.disabled]} disabled={busy} onPress={onAutoSort}>
          <Text style={styles.btnText}>Auto Sort Nearest</Text>
        </Pressable>
        <Pressable style={[styles.btnSecondary, busy && styles.disabled]} disabled={busy} onPress={onSaveManual}>
          <Text style={styles.btnSecondaryText}>Save Manual Sequence</Text>
        </Pressable>
        <Pressable style={[styles.btn, busy && styles.disabled]} disabled={busy} onPress={onOpenRoute}>
          <Text style={styles.btnText}>Open Route in Google Maps</Text>
        </Pressable>
      </View>

      <FlatList
        data={orderedRows}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listPad}
        ListEmptyComponent={<Text style={styles.empty}>No active deliveries in route.</Text>}
        renderItem={({ item, index }) => {
          const tid = String(item.driver_delivery_task_id);
          const seq = seqDraft[tid] ?? '';
          const gpsOk = hasGps(item);
          return (
            <View style={styles.card}>
              <View style={styles.rowTop}>
                <Text style={styles.seqLabel}>Seq</Text>
                <TextInput
                  value={seq}
                  keyboardType="numeric"
                  onChangeText={(t) => setSeqDraft((s) => ({ ...s, [tid]: t }))}
                  style={styles.seqInput}
                  placeholder={String(item.sequence_no ?? index + 1)}
                  placeholderTextColor="#94a3b8"
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.ob}>{item.outbound_number || '—'}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {item.customer_name || '—'} {item.city_name ? `· ${item.city_name}` : ''}
                  </Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{gpsOk ? 'GPS' : 'NO GPS'}</Text>
                </View>
              </View>

              <View style={styles.actions}>
                <Pressable style={[styles.mini, !gpsOk && styles.disabled]} disabled={!gpsOk} onPress={() => void onOpenIndividual(item)}>
                  <Text style={styles.miniText}>Open Individual Location</Text>
                </Pressable>
                <Pressable style={styles.mini} onPress={() => onMove(item.driver_delivery_task_id, -1)}>
                  <Text style={styles.miniText}>Move Up</Text>
                </Pressable>
                <Pressable style={styles.mini} onPress={() => onMove(item.driver_delivery_task_id, 1)}>
                  <Text style={styles.miniText}>Move Down</Text>
                </Pressable>
              </View>
            </View>
          );
        }}
      />

      <Pressable style={styles.footerLink} onPress={() => void load()}>
        <Text style={styles.footerLinkText}>Refresh</Text>
      </Pressable>
      <Pressable style={styles.footerLink} onPress={() => navigation.goBack()}>
        <Text style={styles.footerLinkText}>Back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  warn: { color: '#92400e', paddingHorizontal: 16, paddingTop: 10, fontSize: 12 },
  toolbar: { padding: 16, gap: 10 },
  btn: { backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '800' },
  btnSecondary: { backgroundColor: '#e2e8f0', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  btnSecondaryText: { color: '#0f172a', fontWeight: '800' },
  disabled: { opacity: 0.55 },
  listPad: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { textAlign: 'center', color: '#64748b', marginTop: 28 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  seqLabel: { fontSize: 11, fontWeight: '800', color: '#475569' },
  seqInput: {
    width: 56,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#f8fafc',
    textAlign: 'center',
    fontWeight: '800',
    color: '#0f172a',
  },
  ob: { fontSize: 16, fontWeight: '900', color: '#0f172a' },
  sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  badge: { backgroundColor: '#eff6ff', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  badgeText: { fontSize: 11, fontWeight: '800', color: '#1d4ed8' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  mini: { backgroundColor: '#f1f5f9', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10 },
  miniText: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  footerLink: { padding: 10, alignItems: 'center' },
  footerLinkText: { color: '#2563eb', fontWeight: '700' },
});

