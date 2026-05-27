import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { PartSuggestInput, type PartSuggestRow } from '../components/StockSuggestFields';
import { suggestMainStockForMobile } from '../api/stockLookupApi';
import { formatApiError } from '../api/client';
import { updateRackBatch } from '../api/rackMobileApi';
import { getSelectedWarehouseId } from '../storage/warehouseStorage';
import { me } from '../api/authApi';
import {
  appendRackUpdatePending,
  clearRackUpdatePending,
  loadRackUpdatePending,
  removeRackUpdatePending,
  type RackUpdatePendingRow,
} from '../storage/rackUpdatePendingStorage';

const PART_SUGGEST_LIMIT = 40;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parsePositiveQty(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export default function ScanRackScreen() {
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [userLabel, setUserLabel] = useState('');

  const [part, setPart] = useState('');
  const [sap, setSap] = useState('');
  const [description, setDescription] = useState('');
  const [uom, setUom] = useState('');
  const [rack, setRack] = useState('');
  const [qty, setQty] = useState('');
  const [pending, setPending] = useState<RackUpdatePendingRow[]>([]);
  const [busy, setBusy] = useState(false);

  const refRack = useRef<TextInput>(null);
  const refQty = useRef<TextInput>(null);

  const refreshPending = useCallback(async () => {
    setPending(await loadRackUpdatePending());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshPending();
      void getSelectedWarehouseId().then((id) => setWarehouseId(id));
      void me()
        .then(({ user }) => setUserLabel(String(user.full_name || user.username || '').trim()))
        .catch(() => setUserLabel(''));
    }, [refreshPending])
  );

  const fetchPartSuggest = useCallback(
    (q: string) => suggestMainStockForMobile(q, PART_SUGGEST_LIMIT),
    []
  );

  const onPickPartFromStock = useCallback((row: PartSuggestRow) => {
    const pn = String(row.part_number || '').trim();
    setPart(pn);
    setSap(String(row.sap_part_number ?? pn).trim());
    setDescription(String(row.description ?? '').trim());
    setUom(String(row.uom ?? '').trim());
    setTimeout(() => refRack.current?.focus(), 120);
  }, []);

  const qtyParsed = parsePositiveQty(qty);
  const canSaveLocal =
    part.trim().length > 0 && rack.trim().length > 0 && qty.trim().length > 0 && qtyParsed != null;

  const saveLocal = async () => {
    if (!canSaveLocal || qtyParsed == null) return;
    const rows = await appendRackUpdatePending({
      part_number: part.trim(),
      sap_part_number: sap.trim() || part.trim(),
      description: description.trim(),
      uom: uom.trim(),
      rack_location: rack.trim().toUpperCase(),
      qty: String(qtyParsed),
      entry_date: todayIso(),
      remarks: 'Mobile rack scan',
      saved_by: userLabel || 'Unknown',
    });
    setPending(rows);
    setPart('');
    setSap('');
    setDescription('');
    setUom('');
    setRack('');
    setQty('');
    Alert.alert('Saved on device', `${rows.length} row(s) waiting. Tap Update Stock By Rack when ready.`);
  };

  const submitUpdate = () => {
    if (!warehouseId) {
      Alert.alert('Warehouse', 'Log in again so warehouse is set on this device.');
      return;
    }
    if (!pending.length) {
      Alert.alert('Nothing pending', 'Add at least one line with Save on device.');
      return;
    }
    Alert.alert(
      'Update Stock By Rack',
      `Upload ${pending.length} row(s) to the server? Description and UOM come from main stock. Your name is recorded on each line.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Update',
          onPress: async () => {
            setBusy(true);
            try {
              const items = pending.map((r) => ({
                part_number: r.part_number,
                sap_part_number: r.sap_part_number || undefined,
                description: r.description || undefined,
                rack_location: r.rack_location,
                qty: Number(r.qty),
                entry_date: r.entry_date,
                remarks: [r.remarks, r.saved_by ? `By ${r.saved_by}` : null].filter(Boolean).join(' · ') || undefined,
              }));
              await updateRackBatch(warehouseId, items);
              await clearRackUpdatePending();
              setPending([]);
              Alert.alert('Success', 'Stock By Rack updated.');
            } catch (e) {
              Alert.alert('Update failed', formatApiError(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const clearAll = () => {
    Alert.alert('Clear pending?', 'Removes all lines saved on this device (not uploaded yet).', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await clearRackUpdatePending();
          setPending([]);
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
      <ScrollView
        style={styles.wrap}
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.h}>Scan Rack</Text>
        <Text style={styles.note}>
          Pick a part from main stock, enter rack location and quantity only. Lines stay on this device until you tap
          Update Stock By Rack.
        </Text>
        {userLabel ? (
          <Text style={styles.userLine}>
            Logged in as <Text style={styles.userBold}>{userLabel}</Text>
          </Text>
        ) : null}

        <Text style={styles.label}>Part number</Text>
        <PartSuggestInput
          wrapStyle={styles.partSuggestWrap}
          value={part}
          onChangeText={(t) => {
            setPart(t);
            if (!t.trim()) {
              setSap('');
              setDescription('');
              setUom('');
            }
          }}
          fetchSuggest={fetchPartSuggest}
          onPick={onPickPartFromStock}
          placeholder="Type to search main stock, then pick from list"
          returnKeyType="next"
          onSubmitEditing={() => refRack.current?.focus()}
        />

        <Text style={styles.label}>Description (from main stock)</Text>
        <Text style={styles.readOnly}>{description || '—'}</Text>

        <Text style={styles.label}>UOM (from main stock)</Text>
        <Text style={styles.readOnly}>{uom || '—'}</Text>

        <Text style={styles.label}>Rack location</Text>
        <TextInput
          ref={refRack}
          style={styles.input}
          value={rack}
          onChangeText={setRack}
          placeholder="e.g. A-01-02"
          placeholderTextColor="#94a3b8"
          autoCapitalize="characters"
          returnKeyType="next"
          onSubmitEditing={() => refQty.current?.focus()}
        />

        <Text style={styles.label}>Quantity</Text>
        <TextInput
          ref={refQty}
          style={styles.input}
          value={qty}
          onChangeText={setQty}
          keyboardType="decimal-pad"
          placeholder="Number greater than zero"
          placeholderTextColor="#94a3b8"
        />

        <View style={styles.toolbar}>
          <Pressable style={[styles.tb, !canSaveLocal && styles.tbDisabled]} disabled={!canSaveLocal} onPress={() => void saveLocal()}>
            <Text style={styles.tbText}>Save on device</Text>
          </Pressable>
          <Pressable style={styles.tbSec} onPress={clearAll}>
            <Text style={styles.tbSecText}>Clear pending</Text>
          </Pressable>
        </View>

        <Text style={styles.pendingTitle}>Pending on device ({pending.length})</Text>
        {pending.length === 0 ? (
          <Text style={styles.empty}>No lines yet. Save on device adds rows here before upload.</Text>
        ) : (
          pending.map((item) => (
            <View key={item.id} style={styles.card}>
              <Text style={styles.cardPart}>{item.part_number}</Text>
              <Text style={styles.cardMeta}>
                Rack {item.rack_location} · Qty {item.qty}
                {item.uom ? ` · ${item.uom}` : ''}
              </Text>
              {item.description ? (
                <Text style={styles.cardDesc} numberOfLines={2}>
                  {item.description}
                </Text>
              ) : null}
              <Text style={styles.cardBy}>
                {item.entry_date}
                {item.saved_by ? ` · ${item.saved_by}` : ''}
              </Text>
              <Pressable onPress={() => void removeRackUpdatePending(item.id).then(setPending)}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          ))
        )}

        <Pressable style={[styles.updateBtn, (busy || !pending.length) && styles.tbDisabled]} disabled={busy || !pending.length} onPress={submitUpdate}>
          <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
          <Text style={styles.updateBtnText}>{busy ? 'Updating…' : 'Update Stock By Rack'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 12 },
  h: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  note: { fontSize: 11, color: '#64748b', marginVertical: 8, lineHeight: 16 },
  userLine: { fontSize: 11, color: '#475569', marginBottom: 8 },
  userBold: { fontWeight: '800', color: '#0f172a' },
  label: { fontSize: 11, fontWeight: '700', color: '#475569', marginTop: 10 },
  partSuggestWrap: { zIndex: 30, marginTop: 4 },
  readOnly: {
    marginTop: 4,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    fontSize: 13,
    color: '#334155',
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    backgroundColor: '#fff',
    color: '#0f172a',
    fontSize: 14,
  },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  tb: { backgroundColor: '#2563eb', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  tbDisabled: { opacity: 0.45 },
  tbText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  tbSec: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  tbSecText: { fontWeight: '700', fontSize: 12, color: '#334155' },
  pendingTitle: { fontSize: 12, fontWeight: '800', color: '#0f172a', marginTop: 20, marginBottom: 8 },
  empty: { fontSize: 12, color: '#64748b', lineHeight: 17 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardPart: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  cardMeta: { fontSize: 11, color: '#475569', marginTop: 4 },
  cardDesc: { fontSize: 11, color: '#64748b', marginTop: 4 },
  cardBy: { fontSize: 10, color: '#94a3b8', marginTop: 4 },
  remove: { color: '#dc2626', fontSize: 11, fontWeight: '700', marginTop: 8 },
  updateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#059669',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 16,
  },
  updateBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
