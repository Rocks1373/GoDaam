import { useCallback, useState } from 'react';
import { View, Text, Pressable, FlatList, StyleSheet, ActivityIndicator, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PartSuggestInput, type PartSuggestRow } from '../components/StockSuggestFields';
import {
  listMainStockForMobile,
  suggestMainStockForMobile,
  type MainStockRow,
} from '../api/stockLookupApi';

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const s = String(v).trim();
  return s.length ? s : '—';
}

export default function MainStockCheckScreen() {
  const [partFilter, setPartFilter] = useState('');
  const [rows, setRows] = useState<MainStockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSuggest = useCallback((q: string) => suggestMainStockForMobile(q), []);

  const runSearch = useCallback(async (explicitPart?: string) => {
    Keyboard.dismiss();
    const q = (explicitPart !== undefined ? explicitPart : partFilter).trim();
    setLoading(true);
    setError(null);
    try {
      const data = await listMainStockForMobile({
        part_number: q || undefined,
        limit: 100,
      });
      setRows(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { error?: string } } };
      const msg =
        err.response?.status === 403
          ? 'You do not have permission to view main stock.'
          : err.response?.data?.error || 'Could not load stock.';
      setError(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [partFilter]);

  const onPickPart = useCallback(
    (_row: PartSuggestRow) => {
      void runSearch(_row.part_number);
    },
    [runSearch]
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.hint}>
        Read-only · type to see suggestions, tap a part to load details (your text stays in the field)
      </Text>
      <View style={styles.filterRow}>
        <PartSuggestInput
          wrapStyle={styles.partSuggestWrap}
          value={partFilter}
          onChangeText={setPartFilter}
          fetchSuggest={fetchSuggest}
          onPick={onPickPart}
          placeholder="Part number"
          returnKeyType="search"
          onSubmitEditing={() => void runSearch()}
          rightAccessory={
            <Pressable
              style={({ pressed }) => [styles.iconSearch, pressed && styles.iconSearchPressed]}
              onPress={() => void runSearch()}
              disabled={loading}
              hitSlop={8}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Ionicons name="search" size={22} color="#2563eb" />
              )}
            </Pressable>
          }
        />
      </View>
      {error ? <Text style={styles.err}>{error}</Text> : null}

      <FlatList
        data={rows}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item, index) => `${String(item.part_number ?? item.id ?? index)}`}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !loading ? (
            <Text style={styles.empty}>
              Type letters to see matches, pick one or tap the search icon.
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.part}>{fmt(item.part_number)}</Text>
            {item.sap_part_number ? (
              <Text style={styles.meta}>SAP: {fmt(item.sap_part_number)}</Text>
            ) : null}
            <Text style={styles.desc} numberOfLines={3}>
              {fmt(item.description)}
            </Text>
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
  filterRow: { flexDirection: 'row', gap: 10, marginBottom: 8, alignItems: 'flex-start' },
  partSuggestWrap: { flex: 1, zIndex: 20 },
  iconSearch: { padding: 4 },
  iconSearchPressed: { opacity: 0.7 },
  err: { color: '#b91c1c', fontSize: 13, marginBottom: 8 },
  listContent: { paddingBottom: 24 },
  empty: { color: '#94a3b8', marginTop: 20, textAlign: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  part: { fontSize: 17, fontWeight: '800', color: '#0f172a' },
  meta: { fontSize: 12, color: '#64748b', marginTop: 4 },
  desc: { fontSize: 14, color: '#334155', marginTop: 8, lineHeight: 20 },
  qtyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 10, gap: 6 },
  qtyLabel: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  qtyVal: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  qtySep: { color: '#cbd5e1', marginHorizontal: 4 },
});
