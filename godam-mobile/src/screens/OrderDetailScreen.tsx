import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert, Modal } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { getOrder } from '../api/ordersApi';
import { confirmItem, confirmOrder, requestPickChange } from '../api/pickingApi';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderDetail'>;

type ItemRow = {
  id: number;
  material?: string;
  part_number?: string;
  sap_part_number?: string;
  required_qty?: number;
  available_qty_main_stock?: number;
  picked_qty?: number;
  picked_qty_effective?: number;
  remaining_qty?: number;
};

type FifoRow = {
  id: number;
  outbound_item_id: number;
  material?: string;
  sap_part_number?: string;
  rack_location: string;
  suggested_qty: number;
  fifo_sequence: number;
  fifo_picked_qty?: number;
};

const QTY_EPS = 1e-6;

function parseQtyInput(s: string): number | null {
  const n = Number(String(s).trim().replace(',', '.'));
  if (!Number.isFinite(n) || !(n > 0)) return null;
  return n;
}

function toQty(v: unknown, fallback = 0): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

/** API sometimes differs by shape; keep picking UX stable. */
function normalizeItemsFromDetail(raw: unknown): ItemRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row): ItemRow => {
    const r = row as Record<string, unknown>;
    const pickedCol = toQty(r.picked_qty ?? r.pickedQty, 0);
    const effRaw = r.picked_qty_effective ?? r.pickedQtyEffective;
    const eff =
      effRaw === undefined || effRaw === null || effRaw === '' ? pickedCol : toQty(effRaw, pickedCol);
    const picked_qty_effective = Math.max(pickedCol, eff);
    const required_qty = toQty(r.required_qty ?? r.requiredQty, 0);
    let remaining_qty: number | undefined;
    const remRaw = r.remaining_qty ?? r.remainingQty;
    if (remRaw !== undefined && remRaw !== null && remRaw !== '') {
      const rm = toQty(remRaw, NaN);
      if (Number.isFinite(rm)) remaining_qty = rm;
    }
    const id = toQty(r.id, NaN);
    return {
      ...(r as unknown as ItemRow),
      id: Number.isFinite(id) ? id : 0,
      picked_qty: pickedCol,
      picked_qty_effective,
      required_qty,
      remaining_qty,
    };
  });
}

/** Same notion of “picked” everywhere (avoid `effective ?? column` treating 0 as missing). */
function effectivePicked(it: ItemRow): number {
  return Math.max(Number(it.picked_qty) || 0, Number(it.picked_qty_effective) || 0);
}

/** Matches API remaining when present; else derive from req − picked. */
function remainingForLine(it: ItemRow): number {
  const req = Number(it.required_qty) || 0;
  const remApi = Number(it.remaining_qty);
  if (Number.isFinite(remApi)) return Math.max(0, remApi);
  return Math.max(0, req - effectivePicked(it));
}

function linePickComplete(it: ItemRow): boolean {
  const reqN = toQty(it.required_qty, 0);
  if (reqN <= QTY_EPS) return true;
  const pq = effectivePicked(it);
  if (pq + QTY_EPS >= reqN) return true;
  return remainingForLine(it) <= QTY_EPS;
}

function orderFullyPicked(d: Record<string, unknown>): boolean {
  const rows = normalizeItemsFromDetail(d.items);
  if (!rows.length) return false;
  return rows.every(linePickComplete);
}

function extractAxiosErrorData(e: unknown): Record<string, unknown> | null {
  const rec = e as { response?: { data?: unknown } };
  const data = rec.response?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return null;
}

/** Backend returns `shortfalls` with column vs transaction sums — show in alert + log in dev. */
function formatConfirmPickFailureMessage(data: Record<string, unknown>): string {
  let msg = String(data.error ?? 'Confirm failed');
  const shorts = data.shortfalls;
  if (Array.isArray(shorts) && shorts.length > 0) {
    const lines = shorts.map((raw) => {
      const s = raw as Record<string, unknown>;
      const label = String(s.part_number || s.material || s.sap_part_number || '?').trim() || '?';
      const sh = Number(s.shortage);
      const shortageStr = Number.isFinite(sh) ? String(Math.round(sh * 1e6) / 1e6) : String(s.shortage);
      return (
        `#${String(s.item_id)} · ${label}\n` +
        `effective picked ${String(s.picked_effective)} / req ${String(s.required)} (short ${shortageStr})\n` +
        `DB picked_qty column=${String(s.picked_qty_column)} · picked_transactions sum=${String(s.picked_from_transactions)}`
      );
    });
    msg += `\n\nIncomplete line(s):\n\n${lines.join('\n\n')}`;
  } else if (data.item_id != null) {
    msg += `\n\nLine item ${String(data.item_id)}\npicked ${String(data.picked)} / req ${String(data.required)}`;
  }
  return msg;
}

export default function OrderDetailScreen({ route }: Props) {
  const { orderId } = route.params;
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [selectedFifoId, setSelectedFifoId] = useState<number | null>(null);
  const [changeReason, setChangeReason] = useState('');
  const [pickModalOpen, setPickModalOpen] = useState(false);
  const [pickQty, setPickQty] = useState('');
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [reqRack, setReqRack] = useState('');
  const [reqQty, setReqQty] = useState('');

  const load = async (): Promise<Record<string, unknown> | null> => {
    try {
      const d = await getOrder(orderId);
      setDetail(d);
      return d;
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      Alert.alert('Load failed', err.response?.data?.error || 'Error');
      return null;
    }
  };

  useEffect(() => {
    load();
  }, [orderId]);

  const items = useMemo(() => normalizeItemsFromDetail(detail?.items), [detail]);
  const fifos = useMemo(() => {
    const raw = detail?.fifo_suggestions;
    return Array.isArray(raw) ? (raw as FifoRow[]) : [];
  }, [detail]);

  const itemOptions = useMemo(() => {
    return (items || []).map((it) => ({
      id: Number(it.id),
      label: String(it.material || it.part_number || it.sap_part_number || `Item ${it.id}`),
      remaining: Number(it.remaining_qty ?? 0),
      available: Number(it.available_qty_main_stock ?? 0),
      required: Number(it.required_qty ?? 0),
    }));
  }, [items]);

  const selectedItem = useMemo(
    () => items.find((it) => Number(it.id) === Number(selectedItemId)) || null,
    [items, selectedItemId]
  );

  const fifoOptionsForItem = useMemo(() => {
    if (!selectedItemId) return [];
    return fifos
      .filter((f) => Number(f.outbound_item_id) === Number(selectedItemId))
      .map((f) => {
        const already = Number(f.fifo_picked_qty ?? 0);
        const cap = Math.max(0, Number(f.suggested_qty ?? 0) - already);
        return { ...f, max_for_rack: cap };
      })
      .filter((f) => f.max_for_rack > 0);
  }, [fifos, selectedItemId]);

  const selectedFifo = useMemo(
    () => fifoOptionsForItem.find((f) => Number(f.id) === Number(selectedFifoId)) || null,
    [fifoOptionsForItem, selectedFifoId]
  );

  const openPickModal = (itemId: number) => {
    setSelectedItemId(itemId);
    const opts = fifos
      .filter((f) => Number(f.outbound_item_id) === Number(itemId))
      .map((f) => {
        const already = Number(f.fifo_picked_qty ?? 0);
        const cap = Math.max(0, Number(f.suggested_qty ?? 0) - already);
        return { ...f, max_for_rack: cap };
      })
      .filter((f) => f.max_for_rack > 0);

    const selItem = items.find((it) => Number(it.id) === Number(itemId)) ?? null;

    if (opts.length === 1) {
      const only = opts[0];
      setSelectedFifoId(Number(only.id));
      const maxRack = Number(only.max_for_rack ?? 0);
      const remaining = selItem ? remainingForLine(selItem) : 0;
      const exact = Math.max(0, Math.min(maxRack, remaining));
      setPickQty(exact ? String(exact) : '');
    } else {
      setSelectedFifoId(null);
      setPickQty('');
    }
    setPickModalOpen(true);
  };

  const submitPickFromModal = async () => {
    const itId = Number(selectedItemId);
    if (!itId) return Alert.alert('Select part number');

    const fidChosen = Number(selectedFifoId);
    const f =
      fifoOptionsForItem.find((x) => Number(x.id) === fidChosen) ||
      (fifoOptionsForItem.length === 1 ? fifoOptionsForItem[0] : null);
    if (!f) return Alert.alert('Select suggested rack');
    const maxRack = Number((f as any).max_for_rack ?? 0);
    const remaining = selectedItem ? remainingForLine(selectedItem) : 0;
    const exact = Math.max(0, Math.min(maxRack, remaining));
    const picked = parseQtyInput(pickQty);

    if (picked == null) return Alert.alert('Enter quantity');
    if (Math.abs(picked - exact) > QTY_EPS) {
      return Alert.alert('Invalid qty', `You must pick the exact suggested qty now: ${exact}`);
    }

    try {
      await confirmItem({
        outbound_order_id: orderId,
        outbound_item_id: Number(f.outbound_item_id),
        fifo_suggestion_id: Number(f.id),
        scanned_rack: String(f.rack_location || '').trim(),
        picked_qty: picked,
      });
      const fresh = await load();
      setPickModalOpen(false);
      setPickQty('');
      if (fresh && orderFullyPicked(fresh)) {
        try {
          await confirmOrder(orderId);
          await load();
          Alert.alert(
            'Order confirmed picked',
            'Every line is complete. The order is now Picked (rack stock was updated on each pick).'
          );
        } catch (e: unknown) {
          const err = e as { response?: { data?: { error?: string } } };
          Alert.alert(
            'Saved pick',
            err.response?.data?.error ||
              'All lines look complete but auto-finalize failed. Tap “Confirm picked (whole order)”.'
          );
        }
      } else {
        Alert.alert('Saved pick');
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      Alert.alert('Pick failed', err.response?.data?.error || 'Error');
    }
  };

  const openRequestModal = () => {
    if (!selectedItemId) return Alert.alert('Select part number first');
    setReqRack(selectedFifo?.rack_location ? String(selectedFifo.rack_location) : '');
    setReqQty('');
    // Android can ignore opening a second Modal on top of another.
    // Close the pick modal first, then open the request modal.
    setPickModalOpen(false);
    setTimeout(() => setRequestModalOpen(true), 50);
  };

  const submitRequestFromModal = async () => {
    const itId = Number(selectedItemId);
    if (!itId) return Alert.alert('Select part number');
    const q = reqQty.trim() ? Number(reqQty) : null;
    if (reqQty.trim() && !(q && q > 0)) return Alert.alert('Qty must be > 0');
    try {
      await requestPickChange({
        outbound_order_id: orderId,
        outbound_item_id: itId,
        fifo_suggestion_id: selectedFifoId ? Number(selectedFifoId) : null,
        requested_rack_location: reqRack.trim() ? reqRack.trim() : null,
        requested_qty: q,
        reason: changeReason || null,
      });
      setRequestModalOpen(false);
      setChangeReason('');
      Alert.alert('Request sent', 'Admin will review your request.');
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      Alert.alert('Request failed', err.response?.data?.error || 'Error');
    }
  };

  const submitChangeRequest = async () => {
    const itId = Number(selectedItemId);
    if (!itId) {
      Alert.alert('Select Part Number first');
      return;
    }
    try {
      await requestPickChange({
        outbound_order_id: orderId,
        outbound_item_id: itId,
        fifo_suggestion_id: selectedFifoId ? Number(selectedFifoId) : null,
        requested_rack_location: selectedFifo?.rack_location || null,
        requested_qty: null,
        reason: changeReason || null,
      });
      setChangeReason('');
      Alert.alert('Request sent', 'Admin will review your request.');
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      Alert.alert('Request failed', err.response?.data?.error || 'Error');
    }
  };

  const submitConfirmOrder = async () => {
    try {
      await confirmOrder(orderId);
      await load();
      Alert.alert('Order confirmed picked');
    } catch (e: unknown) {
      const data = extractAxiosErrorData(e);
      const msg = data ? formatConfirmPickFailureMessage(data) : 'Confirm failed — no server details.';
      if (__DEV__) {
        // Expo / RN: Metro logs — search “confirm-order failed”
        console.warn('[OrderDetail] confirm-order failed', data ?? e);
      }
      Alert.alert('Confirm failed', msg);
    }
  };

  const allDone = items.length > 0 && items.every(linePickComplete);
  const orderStatus = String(detail?.status ?? '').trim();
  const canConfirmPick =
    items.length > 0 && ['Sent For Pick', 'Picking'].includes(orderStatus);

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.h}>Order #{orderId} · v2</Text>
      <Text style={styles.meta}>Status: {String(detail?.status)}</Text>
      <Text style={styles.meta}>
        {items.length} pick line(s) on this order — scroll through the full list before confirming.
      </Text>

      <View style={styles.card}>
        <Text style={styles.sectionInline}>Request change (rack/qty)</Text>
        <Text style={styles.small}>
          If rack is wrong or stock is not there, send request to admin. Admin will approve and update the order/rack.
        </Text>
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          placeholder="Reason (e.g. rack empty, damaged, wrong label...)"
          value={changeReason}
          onChangeText={setChangeReason}
        />
        <Pressable style={styles.btnSecondary} onPress={submitChangeRequest}>
          <Text style={styles.btnSecondaryText}>Send request</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>Pick list (by Part Number)</Text>
      {items.map((it) => {
        const itemId = Number(it.id);
        const label = String(it.material || it.part_number || '');
        const desc = String((it as any).description || '');
        const req = Number(it.required_qty || 0);
        const avl = it.available_qty_main_stock ?? '-';
        const picked = effectivePicked(it);
        const rem = remainingForLine(it);
        const fifoLines = fifos
          .filter((f) => Number(f.outbound_item_id) === itemId)
          .map((f) => {
            const already = Number(f.fifo_picked_qty ?? 0);
            const max = Math.max(0, Number(f.suggested_qty ?? 0) - already);
            return { ...f, max_for_rack: max };
          })
          .filter((f) => (f as any).max_for_rack > 0);

        return (
          <View key={String(it.id)} style={styles.card}>
            <Text style={styles.bold}>{label}</Text>
            {desc ? <Text style={styles.small}>{desc}</Text> : null}
            <Text style={styles.small}>
              Req {String(req)} · Avl {String(avl)} · Picked {String(picked)} · Rem {String(rem)}
            </Text>

            <Text style={[styles.smallLabel, { marginTop: 10 }]}>Suggested racks</Text>
            {!fifoLines.length ? (
              <Text style={styles.hint}>No FIFO suggestions left for this item.</Text>
            ) : (
              <Pressable style={[styles.btn, { marginTop: 10 }]} onPress={() => openPickModal(itemId)}>
                <Text style={styles.btnText}>Pick / Confirm for this part</Text>
              </Pressable>
            )}
          </View>
        );
      })}

      <Pressable
        style={[styles.btn, !canConfirmPick && styles.btnDisabled]}
        onPress={submitConfirmOrder}
        disabled={!canConfirmPick}
      >
        <Text style={styles.btnText}>Confirm picked (whole order)</Text>
      </Pressable>
      {!canConfirmPick && items.length > 0 ? (
        <Text style={styles.hint}>Confirm is only available while status is Sent For Pick or Picking (current: {orderStatus}).</Text>
      ) : null}
      {canConfirmPick && !allDone ? (
        <Text style={styles.hint}>
          Some lines may still be short on the server. If every line shows Rem 0, tap confirm — partial picks will be rejected with an error.
        </Text>
      ) : null}

      <Modal visible={pickModalOpen} transparent animationType="slide" onRequestClose={() => setPickModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm pickup</Text>
            <Text style={styles.small}>
              Part: {String(selectedItem?.material || selectedItem?.part_number || '')} · Req {String(selectedItem?.required_qty ?? '')} · Avl{' '}
              {String(selectedItem?.available_qty_main_stock ?? '')} · Rem{' '}
              {String(selectedItem ? remainingForLine(selectedItem) : '')}
            </Text>

            <Text style={[styles.smallLabel, { marginTop: 10 }]}>Select suggested rack</Text>
            <View style={styles.pills}>
              {fifoOptionsForItem.map((f) => (
                <Pressable
                  key={String(f.id)}
                  style={[styles.pill, selectedFifoId === Number(f.id) && styles.pillActive]}
                  onPress={() => {
                    setSelectedFifoId(Number(f.id));
                    const maxRack = Number((f as any).max_for_rack ?? 0);
                    const remaining = selectedItem ? remainingForLine(selectedItem) : 0;
                    const exact = Math.max(0, Math.min(maxRack, remaining));
                    setPickQty(exact ? String(exact) : '');
                  }}
                >
                  <Text style={styles.pillText}>
                    {String(f.rack_location)} · Qty {String((f as any).max_for_rack)}
                  </Text>
                  <Text style={styles.pillSub}>Suggested {String(f.suggested_qty)} · Seq {String(f.fifo_sequence)}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.smallLabel, { marginTop: 10 }]}>Quantity (must match suggested)</Text>
            <TextInput style={styles.input} value={pickQty} onChangeText={setPickQty} keyboardType="decimal-pad" placeholder="Qty" />

            <Pressable style={styles.btn} onPress={submitPickFromModal}>
              <Text style={styles.btnText}>Confirm pickup</Text>
            </Pressable>

            <Pressable style={styles.btnSecondary} onPress={openRequestModal}>
              <Text style={styles.btnSecondaryText}>Request change rack/qty</Text>
            </Pressable>

            <Pressable style={[styles.btnSecondary, { marginTop: 8 }]} onPress={() => setPickModalOpen(false)}>
              <Text style={styles.btnSecondaryText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={requestModalOpen} transparent animationType="fade" onRequestClose={() => setRequestModalOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Request change</Text>
            <Text style={styles.small}>Part: {String(selectedItem?.material || selectedItem?.part_number || '')}</Text>
            <TextInput style={styles.input} placeholder="Requested rack (optional)" value={reqRack} onChangeText={setReqRack} autoCapitalize="characters" />
            <TextInput style={styles.input} placeholder="Requested qty (optional)" value={reqQty} onChangeText={setReqQty} keyboardType="decimal-pad" />
            <TextInput style={styles.input} placeholder="Reason" value={changeReason} onChangeText={setChangeReason} />
            <Pressable style={styles.btn} onPress={submitRequestFromModal}>
              <Text style={styles.btnText}>Send request</Text>
            </Pressable>
            <Pressable style={[styles.btnSecondary, { marginTop: 8 }]} onPress={() => setRequestModalOpen(false)}>
              <Text style={styles.btnSecondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 48 },
  h: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  meta: { fontSize: 12, color: '#64748b', marginBottom: 12 },
  section: { marginTop: 16, marginBottom: 8, fontWeight: '700', color: '#334155' },
  sectionInline: { fontWeight: '800', color: '#0f172a', marginBottom: 6 },
  card: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  bold: { fontWeight: '700', color: '#0f172a' },
  small: { fontSize: 12, color: '#64748b', marginTop: 2 },
  smallLabel: { fontSize: 11, fontWeight: '700', color: '#475569', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#fff',
  },
  btn: { backgroundColor: '#2563eb', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: '#fff', fontWeight: '700' },
  hint: { fontSize: 11, color: '#b45309', marginTop: 8 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minWidth: '48%',
  },
  pillAction: { backgroundColor: '#eff6ff', borderColor: '#bfdbfe' },
  pillActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  pillText: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  pillTextActive: { color: '#1d4ed8' },
  pillSub: { marginTop: 2, fontSize: 11, color: '#64748b' },
  pillSubActive: { color: '#1e40af' },
  btnSecondary: {
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  btnSecondaryText: { color: '#0f172a', fontWeight: '700' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: '#fff',
    padding: 14,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a', marginBottom: 8 },
});
