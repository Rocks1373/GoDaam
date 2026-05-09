import { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PartSuggestInput, RackSuggestInput, type PartSuggestRow } from '../components/StockSuggestFields';
import {
  listStockByRackForMobile,
  suggestStockByRackPartForMobile,
  suggestStockByRackRackForMobile,
  type StockByRackRow,
} from '../api/stockLookupApi';

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v).trim();
  return s.length ? s : '—';
}

export default function StockByRackCheckScreen() {
  const [partFilter, setPartFilter] = useState('');
  const [rackFilter, setRackFilter] = useState('');
  const [rows, setRows] = useState<StockByRackRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPartSuggest = useCallback((q: string) => suggestStockByRackPartForMobile(q), []);
  const fetchRackSuggest = useCallback((q: string) => suggestStockByRackRackForMobile(q), []);

  const runSearch = useCallback(
    async (opts?: { part?: string; rack?: string }) => {
      Keyboard.dismiss();
      const p = (opts?.part !== undefined ? opts.part : partFilter).trim();
      const r = (opts?.rack !== undefined ? opts.rack : rackFilter).trim();
      setLoading(true);
      setError(null);
      try {
        const data = await listStockByRackForMobile({
          part_number: p || undefined,
          rack_location: r || undefined,
          limit: 150,
        });
        setRows(Array.isArray(data) ? data : []);
      } catch (e: unknown) {
        const err = e as { response?: { status?: number; data?: { error?: string } } };
        const msg =
          err.response?.status === 403
            ? 'You do not have permission to view stock by rack.'
            : err.response?.data?.error || 'Could not load stock.';
        setError(msg);
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [partFilter, rackFilter]
  );

  const onPickPart = useCallback(
    (row: PartSuggestRow) => {
      void runSearch({ part: row.part_number });
    },
    [runSearch]
  );

  const onPickRack = useCallback(
    (rack: string) => {
      void runSearch({ rack });
    },
    [runSearch]
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.hint}>
        Read-only · type for suggestions; tap a line to load stock (fields keep what you type / pick)
      </Text>

      <PartSuggestInput
        wrapStyle={styles.partWrap}
        value={partFilter}
        onChangeText={setPartFilter}
        fetchSuggest={fetchPartSuggest}
        onPick={onPickPart}
        placeholder="Part number (optional)"
      />

      <RackSuggestInput
        wrapStyle={styles.rackWrap}
        value={rackFilter}
        onChangeText={setRackFilter}
        fetchSuggest={fetchRackSuggest}
        onPick={onPickRack}
        placeholder="Rack location (optional)"
        returnKeyType="search"
        onSubmitEditing={() => void runSearch()}
      />

      <Pressable
        style={({ pressed }) => [styles.searchBtn, pressed && styles.searchBtnPressed]}
        onPress={() => void runSearch()}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="search" size={20} color="#fff" style={styles.searchIcon} />
            <Text style={styles.searchBtnText}>Search</Text>
          </>
        )}
      </Pressable>
      {error ? <Text style={styles.err}>{error}</Text> : null}

      <FlatList
        data={rows}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item, index) =>
          `${String(item.id ?? item.part_number)}-${String(item.rack_location)}-${index}`
        }
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>
              Type part and/or rack for suggestions, or tap Search for a sample list.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardTop}>
              <Text style={styles.rack}>{fmt(item.rack_location)}</Text>
              <Text style={styles.part}>{fmt(item.part_number)}</Text>
            </View>
            {item.description ? (
              <Text style={styles.desc} numberOfLines={2}>
                {fmt(item.description)}
              </Text>
            ) : null}
            <View style={styles.qtyRow}>
              <Text style={styles.qtyLabel}>Available</Text>
              <Text style={styles.qtyVal}>{fmt(item.available_qty)}</Text>
              <Text style={styles.qtySep}>·</Text>
              <Text style={styles.qtyLabel}>UOM</Text>
              <Text style={styles.qtyVal}>{fmt(item.uom)}</Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1f5f9', paddingHorizontal: 16, paddingTop: 12 },
  hint: { fontSize: 13, color: '#64748b', marginBottom: 10 },
  partWrap: { zIndex: 20 },
  rackWrap: { zIndex: 15, marginTop: 10 },
  searchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#2563eb',
  },
  searchBtnPressed: { opacity: 0.85 },
  searchIcon: { marginRight: 0 },
  searchBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  err: { color: '#b91c1c', fontSize: 13, marginTop: 10 },
  listContent: { paddingBottom: 24, paddingTop: 8 },
  empty: { color: '#94a3b8', marginTop: 20, textAlign: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  rack: { fontSize: 15, fontWeight: '800', color: '#1d4ed8', flex: 1 },
  part: { fontSize: 15, fontWeight: '700', color: '#0f172a', textAlign: 'right', flex: 1 },
  desc: { fontSize: 13, color: '#64748b', marginTop: 8, lineHeight: 18 },
  qtyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 10, gap: 6 },
  qtyLabel: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  qtyVal: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  qtySep: { color: '#cbd5e1', marginHorizontal: 4 },
});
