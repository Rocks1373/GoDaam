import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  Modal,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { formatApiError } from '../api/client';
import { getOrder, getOrderStockOverview, markOrderSeen, type StockOverviewLine } from '../api/ordersApi';
import { confirmItem, confirmOrder, confirmItemFromRack, confirmItemWithNewRack, requestPickChange } from '../api/pickingApi';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderDetail'>;

/** Float tolerance for qty comparisons (Hermes throws if an undeclared name is used). */
const QTY_EPS = 1e-6;

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
  description?: string;
  parent_part_number?: string;
  outbound_bom_requirement_id?: number;
  is_bom_expansion?: number;
  rack_location: string;
  suggested_qty: number;
  fifo_sequence: number;
  fifo_picked_qty?: number;
};

/** BOM FIFO lines are child qty; do not cap by parent remaining. */
function exactPickQtyForFifo(
  f: FifoRow & { max_for_rack?: number },
  selectedItem: ItemRow | null
): number {
  const maxRack = Number((f as { max_for_rack?: number }).max_for_rack ?? 0);
  if (!(maxRack > 0)) return 0;
  const fifoBom = Boolean(f.outbound_bom_requirement_id || f.is_bom_expansion);
  if (fifoBom) return maxRack;
  const remaining = selectedItem ? remainingForLine(selectedItem) : 0;
  return Math.max(0, Math.min(maxRack, remaining));
}

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

function fmtQty(v: unknown): string {
  const n = toQty(v, NaN);
  return Number.isFinite(n) ? String(n) : '—';
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

export default function OrderDetailScreen({ route, navigation }: Props) {
  const { orderId } = route.params;
  const { width: winW } = useWindowDimensions();
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [stockLines, setStockLines] = useState<StockOverviewLine[]>([]);
  const [rackFilter, setRackFilter] = useState('');
  const [rackFilterDebounced, setRackFilterDebounced] = useState('');
  const [stockOvLoading, setStockOvLoading] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [selectedFifoId, setSelectedFifoId] = useState<number | null>(null);
  const [changeReason, setChangeReason] = useState('');
  const [pickModalOpen, setPickModalOpen] = useState(false);
  const [pickMode, setPickMode] = useState<'fifo' | 'single_rack' | 'add_rack'>('fifo');
  const [selectedSingleRack, setSelectedSingleRack] = useState<{
    rackId: number;
    obrId: number | null;
    rackLoc: string;
    maxQty: number;
  } | null>(null);
  const [newRackLocation, setNewRackLocation] = useState('');
  const [addRackBomReqId, setAddRackBomReqId] = useState<number | null>(null);
  const [pickQty, setPickQty] = useState('');
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [reqRack, setReqRack] = useState('');
  const [reqQty, setReqQty] = useState('');

  const load = async (): Promise<Record<string, unknown> | null> => {
    try {
      const d = await getOrder(orderId);
      setDetail(d);
      void markOrderSeen(orderId).catch(() => {});
      return d;
    } catch (e: unknown) {
      Alert.alert('Load failed', formatApiError(e));
      return null;
    }
  };

  useEffect(() => {
    load();
  }, [orderId]);

  useEffect(() => {
    const t = setTimeout(() => setRackFilterDebounced(rackFilter.trim()), 400);
    return () => clearTimeout(t);
  }, [rackFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStockOvLoading(true);
      try {
        const ov = await getOrderStockOverview(orderId, rackFilterDebounced || undefined);
        if (!cancelled) setStockLines(ov.lines || []);
      } catch {
        if (!cancelled) setStockLines([]);
      } finally {
        if (!cancelled) setStockOvLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, rackFilterDebounced]);

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

  type SingleRackOpt = {
    key: string;
    rackId: number;
    rackLoc: string;
    avail: number;
    qty: number;
    obrId: number | null;
    label: string;
  };

  const singleRackOptions = useMemo((): SingleRackOpt[] => {
    if (pickMode !== 'single_rack' || !selectedItemId) return [];
    const sl = stockLines.find((x) => Number(x.outbound_item_id) === Number(selectedItemId));
    if (!sl) return [];
    const out: SingleRackOpt[] = [];
    if (sl.is_bom_parent && Array.isArray(sl.bom_child_lines) && sl.bom_child_lines.length > 0) {
      for (const bl of sl.bom_child_lines) {
        const obrId = Number(bl.outbound_bom_requirement_id) || 0;
        const remC = Number(bl.remaining_child_qty) || 0;
        if (remC <= QTY_EPS) continue;
        const racks = Array.isArray(bl.racks) ? bl.racks : [];
        for (const raw of racks) {
          const r = raw as Record<string, unknown>;
          const rackId = Number(r.id);
          const avail = Number(r.available_qty) || 0;
          if (!(rackId > 0) || avail <= QTY_EPS) continue;
          const rackLoc = String(r.rack_location || '').trim();
          const qty = Math.min(remC, avail);
          const cpn = String(bl.child_part_number || '').trim() || 'child';
          out.push({
            key: `obr${obrId}-rack${rackId}`,
            rackId,
            rackLoc,
            avail,
            qty,
            obrId: obrId || null,
            label: `${cpn} · ${rackLoc} · pick up to ${qty}`,
          });
        }
      }
    } else {
      const selIt = items.find((it) => Number(it.id) === Number(selectedItemId)) || null;
      const rem = selIt ? remainingForLine(selIt) : 0;
      if (rem <= QTY_EPS) return [];
      const racks = Array.isArray(sl.racks) ? sl.racks : [];
      for (const raw of racks) {
        const r = raw as Record<string, unknown>;
        const rackId = Number(r.id);
        const avail = Number(r.available_qty) || 0;
        if (!(rackId > 0) || avail <= QTY_EPS) continue;
        const rackLoc = String(r.rack_location || '').trim();
        const qty = Math.min(rem, avail);
        out.push({
          key: `rack${rackId}`,
          rackId,
          rackLoc,
          avail,
          qty,
          obrId: null,
          label: `${rackLoc} · avail ${avail} · pick up to ${qty}`,
        });
      }
    }
    return out;
  }, [pickMode, selectedItemId, stockLines, items]);

  const bomChildPickOptions = useMemo(() => {
    if (!selectedItemId || pickMode !== 'add_rack') return [];
    const sl = stockLines.find((x) => Number(x.outbound_item_id) === Number(selectedItemId));
    if (!sl?.bom_child_lines?.length) return [];
    return sl.bom_child_lines
      .filter((bl) => Number(bl.remaining_child_qty) > QTY_EPS)
      .map((bl) => ({
        id: Number(bl.outbound_bom_requirement_id) || 0,
        label: `${String(bl.child_part_number || '').trim()} · rem ${String(bl.remaining_child_qty ?? '')}`,
        rem: Number(bl.remaining_child_qty) || 0,
      }))
      .filter((o) => o.id > 0);
  }, [pickMode, selectedItemId, stockLines]);

  const openPickModal = (itemId: number) => {
    setPickMode('fifo');
    setSelectedSingleRack(null);
    setNewRackLocation('');
    setAddRackBomReqId(null);
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
      const exact = exactPickQtyForFifo(only as FifoRow & { max_for_rack?: number }, selItem);
      setPickQty(exact ? String(exact) : '');
    } else {
      setSelectedFifoId(null);
      setPickQty('');
    }
    setPickModalOpen(true);
  };

  const openSingleRackPickModal = (itemId: number) => {
    setPickMode('single_rack');
    setSelectedFifoId(null);
    setSelectedSingleRack(null);
    setNewRackLocation('');
    setAddRackBomReqId(null);
    setSelectedItemId(itemId);
    setPickQty('');
    setPickModalOpen(true);
  };

  function computeAddRackDefaultsForItemId(itemId: number): { qty: string; bomReqId: number | null } {
    const sel = items.find((x) => Number(x.id) === Number(itemId)) ?? null;
    const sl = stockLines.find((x) => Number(x.outbound_item_id) === Number(itemId));
    if (sl?.bom_child_lines?.length) {
      const first = sl.bom_child_lines.find((bl) => Number(bl.remaining_child_qty) > QTY_EPS);
      if (first) {
        const bid = Number(first.outbound_bom_requirement_id) || 0;
        return {
          qty: String(Number(first.remaining_child_qty) || ''),
          bomReqId: bid > 0 ? bid : null,
        };
      }
      return { qty: '', bomReqId: null };
    }
    return { qty: sel ? String(remainingForLine(sel)) : '', bomReqId: null };
  }

  const openAddRackPickModal = (itemId: number) => {
    setPickMode('add_rack');
    setSelectedFifoId(null);
    setSelectedSingleRack(null);
    setNewRackLocation('');
    setSelectedItemId(itemId);
    const d = computeAddRackDefaultsForItemId(itemId);
    setAddRackBomReqId(d.bomReqId);
    setPickQty(d.qty);
    setPickModalOpen(true);
  };

  const afterPickSuccess = async (fresh: Record<string, unknown> | null) => {
    setPickModalOpen(false);
    setPickQty('');
    setPickMode('fifo');
    setSelectedSingleRack(null);
    setNewRackLocation('');
    setAddRackBomReqId(null);
    if (fresh && orderFullyPicked(fresh)) {
      try {
        await confirmOrder(orderId);
        await load();
        Alert.alert(
          'Order confirmed picked',
          'Every line is complete. The order is now Picked (rack stock was updated on each pick).'
        );
      } catch (e: unknown) {
        Alert.alert(
          'Saved pick',
          `${formatApiError(e)} Tap “Confirm picked (whole order)” if the order should already be complete.`
        );
      }
    } else {
      Alert.alert('Saved pick');
    }
  };

  const submitSingleRackFromModal = async () => {
    const itId = Number(selectedItemId);
    if (!itId) return Alert.alert('Select part number');
    if (!selectedSingleRack) return Alert.alert('Select a rack');
    const picked = parseQtyInput(pickQty);
    if (picked == null) return Alert.alert('Enter quantity');
    if (picked <= QTY_EPS) return Alert.alert('Enter quantity');
    if (picked - selectedSingleRack.maxQty > QTY_EPS) {
      return Alert.alert('Invalid qty', `Maximum from this rack for the line is ${selectedSingleRack.maxQty}`);
    }
    try {
      await confirmItemFromRack({
        outbound_order_id: orderId,
        outbound_item_id: itId,
        stock_by_rack_id: selectedSingleRack.rackId,
        scanned_rack: selectedSingleRack.rackLoc,
        picked_qty: picked,
        outbound_bom_requirement_id:
          selectedSingleRack.obrId != null ? selectedSingleRack.obrId : undefined,
      });
      const fresh = await load();
      await afterPickSuccess(fresh);
    } catch (e: unknown) {
      Alert.alert('Pick failed', formatApiError(e));
    }
  };

  const submitAddRackFromModal = async () => {
    const itId = Number(selectedItemId);
    if (!itId) return Alert.alert('Select part number');
    const rack = newRackLocation.trim();
    if (!rack) return Alert.alert('Enter rack location');
    const picked = parseQtyInput(pickQty);
    if (picked == null || picked <= QTY_EPS) return Alert.alert('Enter quantity');
    const isBom = bomChildPickOptions.length > 0;
    if (isBom) {
      if (!addRackBomReqId) return Alert.alert('Select child part (BOM line)');
      const opt = bomChildPickOptions.find((o) => o.id === addRackBomReqId);
      if (!opt) return Alert.alert('Select child part (BOM line)');
      if (picked - opt.rem > QTY_EPS) {
        return Alert.alert('Invalid qty', `Maximum remaining for this child is ${opt.rem}`);
      }
    } else {
      const rem = selectedItem ? remainingForLine(selectedItem) : 0;
      if (picked - rem > QTY_EPS) {
        return Alert.alert('Invalid qty', `Maximum remaining for this line is ${rem}`);
      }
    }
    try {
      await confirmItemWithNewRack({
        outbound_order_id: orderId,
        outbound_item_id: itId,
        rack_location: rack,
        picked_qty: picked,
        outbound_bom_requirement_id: addRackBomReqId ?? undefined,
      });
      const fresh = await load();
      await afterPickSuccess(fresh);
    } catch (e: unknown) {
      Alert.alert('Pick failed', formatApiError(e));
    }
  };

  const submitPickFromModal = async () => {
    if (pickMode === 'single_rack') {
      return submitSingleRackFromModal();
    }
    if (pickMode === 'add_rack') {
      return submitAddRackFromModal();
    }
    const itId = Number(selectedItemId);
    if (!itId) return Alert.alert('Select part number');

    const fidChosen = Number(selectedFifoId);
    const f =
      fifoOptionsForItem.find((x) => Number(x.id) === fidChosen) ||
      (fifoOptionsForItem.length === 1 ? fifoOptionsForItem[0] : null);
    if (!f) return Alert.alert('Select suggested rack');
    const exact = exactPickQtyForFifo(f as FifoRow & { max_for_rack?: number }, selectedItem);
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
      await afterPickSuccess(fresh);
    } catch (e: unknown) {
      Alert.alert('Pick failed', formatApiError(e));
    }
  };

  const openRequestModal = () => {
    if (!selectedItemId) return Alert.alert('Select part number first');
    const rackFromFifo = selectedFifo?.rack_location ? String(selectedFifo.rack_location) : '';
    const rackFromSingle = selectedSingleRack?.rackLoc ? String(selectedSingleRack.rackLoc) : '';
    setReqRack(rackFromFifo || rackFromSingle);
    setReqQty('');
    setPickMode('fifo');
    setSelectedSingleRack(null);
    setNewRackLocation('');
    setAddRackBomReqId(null);
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
      Alert.alert('Request failed', formatApiError(e));
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
      Alert.alert('Request failed', formatApiError(e));
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
    <ScrollView style={styles.wrap} nestedScrollEnabled contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.h}>Order #{orderId} · v2</Text>
      <Text style={styles.meta}>Status: {String(detail?.status)}</Text>
      <Text style={styles.meta}>
        {items.length} pick line(s) on this order — scroll through the full list before confirming.
      </Text>

      <View style={styles.stockBlock}>
        <View style={styles.stockHeadRow}>
          <Text style={styles.section}>Stock check</Text>
          <Ionicons name="search" size={18} color="#475569" />
        </View>
        <Text style={styles.stockSub}>
          Swipe cards for each pick line. SAP & vendor # are a quick peek. Tap a card for full main stock + rack
          list (read-only). Edits are on the web app.
        </Text>
        <View style={styles.searchRow}>
          <Ionicons name="search-outline" size={20} color="#64748b" style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Filter by rack location (contains…)"
            placeholderTextColor="#94a3b8"
            value={rackFilter}
            onChangeText={setRackFilter}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
        {stockOvLoading ? <Text style={styles.hint}>Loading stock overview…</Text> : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={Math.min(winW * 0.86, 340) + 10}
          decelerationRate="fast"
          snapToAlignment="start"
          contentContainerStyle={styles.peekList}
        >
          {stockLines.map((item) => (
            <Pressable
              key={String(item.outbound_item_id)}
              style={[styles.peekCard, { width: Math.min(winW * 0.86, 340) }]}
              onPress={() =>
                navigation.navigate('StockPeek', { orderId, outboundItemId: item.outbound_item_id })
              }
            >
              <Text style={styles.peekTitle} numberOfLines={1}>
                {String(item.material || item.part_number || 'Part')}
              </Text>
              <Text style={styles.peekRow}>SAP: {item.sap_part_number?.trim() ? item.sap_part_number : '—'}</Text>
              <Text style={styles.peekRow}>Vendor #: {item.vendor_number?.trim() ? item.vendor_number : '—'}</Text>
              <Text style={styles.peekMeta}>
                Main avail {item.main_stock?.available_qty != null ? fmtQty(item.main_stock.available_qty) : '—'} · Racks{' '}
                {Array.isArray(item.racks) ? item.racks.length : 0}
              </Text>
              <Text style={styles.peekTap}>Tap for details · reject / QA review only</Text>
            </Pressable>
          ))}
        </ScrollView>
        {!stockOvLoading && stockLines.length === 0 ? (
          <Text style={styles.hint}>No stock lines loaded for this order.</Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionInline}>Request change (rack/qty)</Text>
        <Text style={styles.small}>
          If rack is wrong or stock is not there, send request to admin. Admin will approve and update the order/rack.
        </Text>
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          placeholder="Reason (e.g. rack empty, damaged, wrong label...)"
          placeholderTextColor="#94a3b8"
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
        const isBomParent = Boolean((it as any).is_bom_parent);

        return (
          <View key={String(it.id)} style={styles.card}>
            <Text style={styles.bold}>{label}</Text>
            {isBomParent ? (
              <Text style={[styles.small, { color: '#92400e', fontWeight: '600' }]}>BOM parent — pick child lines below</Text>
            ) : null}
            {desc ? <Text style={styles.small}>{desc}</Text> : null}
            <Text style={styles.small}>
              Req {String(req)} · Avl {String(avl)} · Picked {String(picked)} · Rem {String(rem)}
            </Text>

            <Text style={[styles.smallLabel, { marginTop: 10 }]}>Pick</Text>
            {rem > QTY_EPS ? (
              <View style={{ gap: 8, marginTop: 10 }}>
                {fifoLines.length > 0 ? (
                  <Pressable style={styles.btn} onPress={() => openPickModal(itemId)}>
                    <Text style={styles.btnText}>Pick (FIFO)</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={[styles.btn, { backgroundColor: '#7c3aed', opacity: fifoLines.length > 0 ? 0.5 : 1 }]}
                  onPress={() => {
                    if (fifoLines.length > 0) {
                      Alert.alert(
                        'FIFO active',
                        'Finish FIFO suggestions first, or use “Add new rack location” to declare stock at a new bin.'
                      );
                      return;
                    }
                    openSingleRackPickModal(itemId);
                  }}
                >
                  <Text style={styles.btnText}>From existing rack</Text>
                </Pressable>
                <Pressable
                  style={[styles.btnSecondary, { borderColor: '#047857', borderWidth: 2 }]}
                  onPress={() => openAddRackPickModal(itemId)}
                >
                  <Text style={[styles.btnSecondaryText, { color: '#047857' }]}>Add new rack location</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={[styles.hint, { marginTop: 8 }]}>Line complete or no remaining qty.</Text>
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

      <Modal
        visible={pickModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setPickModalOpen(false);
          setPickMode('fifo');
          setSelectedSingleRack(null);
          setNewRackLocation('');
          setAddRackBomReqId(null);
        }}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {pickMode === 'single_rack'
                ? 'Pick from existing rack'
                : pickMode === 'add_rack'
                  ? 'Add new rack location & pick'
                  : 'Pick (FIFO)'}
            </Text>
            <Text style={styles.small}>
              Part: {String(selectedItem?.material || selectedItem?.part_number || '')} · Req {String(selectedItem?.required_qty ?? '')} · Avl{' '}
              {String(selectedItem?.available_qty_main_stock ?? '')} · Rem{' '}
              {String(selectedItem ? remainingForLine(selectedItem) : '')}
            </Text>

            {selectedItemId && selectedItem && remainingForLine(selectedItem) > QTY_EPS ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                <Pressable
                  style={[styles.pill, pickMode === 'fifo' && styles.pillActive, fifoOptionsForItem.length === 0 && { opacity: 0.45 }]}
                  onPress={() => {
                    if (fifoOptionsForItem.length === 0) return;
                    setPickMode('fifo');
                    setNewRackLocation('');
                  }}
                >
                  <Text style={styles.pillText}>FIFO</Text>
                </Pressable>
                <Pressable
                  style={[styles.pill, pickMode === 'single_rack' && styles.pillActive, fifoOptionsForItem.length > 0 && { opacity: 0.45 }]}
                  onPress={() => {
                    if (fifoOptionsForItem.length > 0) {
                      Alert.alert(
                        'FIFO active',
                        'Use FIFO or “New rack”. “Existing rack” is only when there are no FIFO lines with quantity left.'
                      );
                      return;
                    }
                    setPickMode('single_rack');
                    setSelectedFifoId(null);
                    setNewRackLocation('');
                  }}
                >
                  <Text style={styles.pillText}>Existing rack</Text>
                </Pressable>
                <Pressable
                  style={[styles.pill, pickMode === 'add_rack' && styles.pillActive]}
                  onPress={() => {
                    setPickMode('add_rack');
                    setSelectedFifoId(null);
                    setSelectedSingleRack(null);
                    setNewRackLocation('');
                    if (selectedItemId) {
                      const d = computeAddRackDefaultsForItemId(selectedItemId);
                      setAddRackBomReqId(d.bomReqId);
                      setPickQty(d.qty);
                    }
                  }}
                >
                  <Text style={styles.pillText}>New rack</Text>
                </Pressable>
              </View>
            ) : null}

            {pickMode === 'fifo' ? (
              <>
                <Text style={[styles.smallLabel, { marginTop: 10 }]}>Select suggested rack</Text>
                {fifoOptionsForItem.length === 0 ? (
                  <Text style={styles.hint}>No FIFO lines with quantity left — switch to Existing rack or New rack.</Text>
                ) : (
                  <View style={styles.pills}>
                    {fifoOptionsForItem.map((f) => (
                      <Pressable
                        key={String(f.id)}
                        style={[styles.pill, selectedFifoId === Number(f.id) && styles.pillActive]}
                        onPress={() => {
                          setSelectedFifoId(Number(f.id));
                          const exact = exactPickQtyForFifo(f as FifoRow & { max_for_rack?: number }, selectedItem);
                          setPickQty(exact ? String(exact) : '');
                        }}
                      >
                        <Text style={styles.pillText}>
                          {f.parent_part_number ? `${f.parent_part_number} → ` : ''}
                          {String(f.material || '')} · {String(f.rack_location)}
                        </Text>
                        <Text style={styles.pillSub}>
                          {f.description ? `${String(f.description)} · ` : ''}Suggested {String(f.suggested_qty)} · Seq{' '}
                          {String(f.fifo_sequence)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}

                {fifoOptionsForItem.length > 0 ? (
                  <>
                    <Text style={[styles.smallLabel, { marginTop: 10 }]}>Quantity (must match suggested)</Text>
                    <TextInput
                      style={styles.input}
                      value={pickQty}
                      onChangeText={setPickQty}
                      keyboardType="decimal-pad"
                      placeholder="Qty"
                      placeholderTextColor="#94a3b8"
                    />
                  </>
                ) : null}
              </>
            ) : pickMode === 'add_rack' ? (
              <>
                <Text style={[styles.smallLabel, { marginTop: 10 }]}>Rack location (bin / aisle)</Text>
                <TextInput
                  style={styles.input}
                  value={newRackLocation}
                  onChangeText={setNewRackLocation}
                  placeholder="e.g. A-12-03"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="characters"
                />
                {bomChildPickOptions.length > 0 ? (
                  <>
                    <Text style={[styles.smallLabel, { marginTop: 6 }]}>Child part (BOM)</Text>
                    <View style={styles.pills}>
                      {bomChildPickOptions.map((o) => (
                        <Pressable
                          key={String(o.id)}
                          style={[styles.pill, addRackBomReqId === o.id && styles.pillActive]}
                          onPress={() => {
                            setAddRackBomReqId(o.id);
                            setPickQty(String(o.rem));
                          }}
                        >
                          <Text style={styles.pillText}>{o.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                ) : null}
                <Text style={[styles.smallLabel, { marginTop: 10 }]}>Pick quantity</Text>
                <TextInput
                  style={styles.input}
                  value={pickQty}
                  onChangeText={setPickQty}
                  keyboardType="decimal-pad"
                  placeholder="Qty"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={[styles.hint, { marginTop: 6 }]}>
                  Saves a stock_by_rack row for this part at this location (if needed), then deducts the pick and records stock_out in one step.
                </Text>
                <Pressable style={[styles.btn, { marginTop: 10, backgroundColor: '#047857' }]} onPress={submitPickFromModal}>
                  <Text style={styles.btnText}>Confirm add rack & pick</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={[styles.smallLabel, { marginTop: 10 }]}>Choose rack (existing stock)</Text>
                {singleRackOptions.length === 0 ? (
                  <Text style={styles.hint}>
                    No rack rows with available stock in the overview. Use New rack tab, or refresh after stock is loaded.
                  </Text>
                ) : (
                  <View style={styles.pills}>
                    {singleRackOptions.map((o) => {
                      const active =
                        selectedSingleRack?.rackId === o.rackId &&
                        (selectedSingleRack?.obrId ?? null) === (o.obrId ?? null);
                      return (
                        <Pressable
                          key={o.key}
                          style={[styles.pill, active && styles.pillActive]}
                          onPress={() => {
                            setSelectedSingleRack({
                              rackId: o.rackId,
                              obrId: o.obrId,
                              rackLoc: o.rackLoc,
                              maxQty: o.qty,
                            });
                            setPickQty(String(o.qty));
                          }}
                        >
                          <Text style={styles.pillText}>{o.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                <Text style={[styles.smallLabel, { marginTop: 10 }]}>Quantity (default = max from rack)</Text>
                <TextInput
                  style={styles.input}
                  value={pickQty}
                  onChangeText={setPickQty}
                  keyboardType="decimal-pad"
                  placeholder="Qty"
                  placeholderTextColor="#94a3b8"
                />
                <Pressable style={styles.btn} onPress={submitPickFromModal}>
                  <Text style={styles.btnText}>Confirm pickup from rack</Text>
                </Pressable>
              </>
            )}

            {pickMode === 'fifo' && fifoOptionsForItem.length > 0 ? (
              <Pressable style={[styles.btn, { marginTop: 10 }]} onPress={submitPickFromModal}>
                <Text style={styles.btnText}>Confirm FIFO pickup</Text>
              </Pressable>
            ) : null}

            <Pressable style={styles.btnSecondary} onPress={openRequestModal}>
              <Text style={styles.btnSecondaryText}>Request change rack/qty</Text>
            </Pressable>

            <Pressable
              style={[styles.btnSecondary, { marginTop: 8 }]}
              onPress={() => {
                setPickModalOpen(false);
                setPickMode('fifo');
                setSelectedSingleRack(null);
                setNewRackLocation('');
                setAddRackBomReqId(null);
              }}
            >
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
            <TextInput style={styles.input} placeholder="Requested rack (optional)" placeholderTextColor="#94a3b8" value={reqRack} onChangeText={setReqRack} autoCapitalize="characters" />
            <TextInput style={styles.input} placeholder="Requested qty (optional)" placeholderTextColor="#94a3b8" value={reqQty} onChangeText={setReqQty} keyboardType="decimal-pad" />
            <TextInput style={styles.input} placeholder="Reason" placeholderTextColor="#94a3b8" value={changeReason} onChangeText={setChangeReason} />
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
    color: '#0f172a',
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
  stockBlock: { marginBottom: 12 },
  stockHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  stockSub: { fontSize: 11, color: '#64748b', lineHeight: 16, marginBottom: 10 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: '#0f172a' },
  peekList: { paddingVertical: 4, paddingRight: 8, gap: 0 },
  peekCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 14,
    marginRight: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  peekTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a', marginBottom: 8 },
  peekRow: { fontSize: 13, color: '#334155', marginTop: 2 },
  peekMeta: { fontSize: 11, color: '#64748b', marginTop: 8 },
  peekTap: { fontSize: 10, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' },
});
