import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ScrollView,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import {
  getInboundBatchDetail,
  listInboundBatches,
  uploadPutaway,
  type InboundBatchRow,
  type InboundItemRow,
} from '../api/inboundPutawayApi';
import {
  appendPutawayLine,
  clearPutawaySessionFile,
  getPutawaySessionUri,
  readPutawayFile,
} from '../storage/putawayLocalStorage';

type ViewMode = 'batches' | 'items' | 'putaway';

export default function ReceivingScreen() {
  const [mode, setMode] = useState<ViewMode>('batches');
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState<InboundBatchRow[]>([]);
  const [batchDetail, setBatchDetail] = useState<{ batch: InboundBatchRow; items: InboundItemRow[] } | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null);
  const [selectedItem, setSelectedItem] = useState<InboundItemRow | null>(null);
  const [rack, setRack] = useState('');
  const [qty, setQty] = useState('');
  const [remarks, setRemarks] = useState('');
  const [localPreview, setLocalPreview] = useState('');
  /** Filter batch line list by part (and description) when the batch has many parts */
  const [itemPartQuery, setItemPartQuery] = useState('');

  const loadBatches = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listInboundBatches();
      setBatches(rows);
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      Alert.alert('Load failed', err.response?.data?.error || err.message || 'Error');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadBatches();
    }, [loadBatches])
  );

  const openBatch = async (id: number) => {
    setLoading(true);
    setItemPartQuery('');
    try {
      const data = await getInboundBatchDetail(id);
      setBatchDetail(data);
      setActiveBatchId(id);
      setMode('items');
      setSelectedItem(null);
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      Alert.alert('Failed', err.response?.data?.error || err.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  const openPutaway = (item: InboundItemRow) => {
    setSelectedItem(item);
    setRack('');
    setQty('');
    setRemarks('');
    setMode('putaway');
  };

  const savePutaway = async () => {
    if (!selectedItem || activeBatchId == null) return;
    const r = rack.trim().toUpperCase();
    const q = Number(qty);
    if (!r || !(q > 0)) {
      Alert.alert('Required', 'Enter rack location and quantity');
      return;
    }
    if (q > selectedItem.remaining_qty + 1e-9) {
      Alert.alert('Too much', `Max remaining: ${selectedItem.remaining_qty}`);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);

    const baseLine = {
      transaction_date: today,
      part_number: selectedItem.part_number,
      rack_location: r,
      qty: q,
      remarks: remarks.trim() || '-',
      inbound_batch_id: activeBatchId,
      inbound_item_id: selectedItem.id,
    };

    try {
      await uploadPutaway({
        inbound_batch_id: activeBatchId,
        inbound_item_id: selectedItem.id,
        part_number: selectedItem.part_number,
        rack_location: r,
        qty: q,
        transaction_date: today,
        remarks: remarks.trim() || undefined,
      });
      await appendPutawayLine({ ...baseLine, synced: 'synced' });
      const tail = await readPutawayFile();
      setLocalPreview(tail.slice(-600));
      Alert.alert('Saved', 'Putaway recorded and synced.');
      if (activeBatchId != null) {
        const data = await getInboundBatchDetail(activeBatchId);
        setBatchDetail(data);
      }
      setMode('items');
      setSelectedItem(null);
    } catch (e) {
      await appendPutawayLine({ ...baseLine, synced: 'pending' });
      const err = e as { response?: { data?: { error?: string } }; message?: string };
      Alert.alert(
        'Sync issue',
        `${err.response?.data?.error || err.message || 'API error'}\n\nSaved to local file as pending — retry when online.`
      );
      const tail = await readPutawayFile();
      setLocalPreview(tail.slice(-600));
    }
  };

  const filteredBatchItems = useMemo(() => {
    const list = batchDetail?.items;
    if (!list?.length) return [];
    const q = itemPartQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((it) => {
      const pn = String(it.part_number ?? '').toLowerCase();
      const desc = String(it.description ?? '').toLowerCase();
      return pn.includes(q) || desc.includes(q);
    });
  }, [batchDetail?.items, itemPartQuery]);

  const shareLocal = async () => {
    const uri = await getPutawaySessionUri();
    if (!uri) {
      Alert.alert('Nothing to share');
      return;
    }
    const ok = await Sharing.isAvailableAsync();
    if (!ok) {
      Alert.alert('Sharing not available');
      return;
    }
    await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle: 'Putaway log' });
  };

  if (mode === 'putaway' && selectedItem && batchDetail) {
    return (
      <ScrollView style={styles.wrap} contentContainerStyle={{ paddingBottom: 40 }}>
        <Pressable onPress={() => setMode('items')} style={styles.back}>
          <Text style={styles.backText}>← Back to items</Text>
        </Pressable>
        <Text style={styles.h}>Putaway</Text>
        <Text style={styles.meta}>
          {batchDetail.batch.batch_name} {batchDetail.batch.vendor_name ? `| ${batchDetail.batch.vendor_name}` : ''}
        </Text>
        <Text style={styles.part}>{selectedItem.part_number}</Text>
        <Text style={styles.desc}>{selectedItem.description || '—'}</Text>
        <View style={styles.row}>
          <Text style={styles.k}>Total</Text>
          <Text style={styles.v}>{selectedItem.total_qty}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.k}>Remaining</Text>
          <Text style={styles.v}>{selectedItem.remaining_qty}</Text>
        </View>
        <Text style={styles.label}>Rack location</Text>
        <TextInput
          style={styles.input}
          value={rack}
          onChangeText={setRack}
          placeholder="A-12B"
          placeholderTextColor="#64748b"
          autoCapitalize="characters"
        />
        <Text style={styles.label}>Qty to put</Text>
        <TextInput
          style={styles.input}
          value={qty}
          onChangeText={setQty}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor="#64748b"
        />
        <Text style={styles.label}>Remarks</Text>
        <TextInput
          style={styles.input}
          value={remarks}
          onChangeText={setRemarks}
          placeholder="-"
          placeholderTextColor="#64748b"
        />
        <Pressable style={styles.btn} onPress={savePutaway}>
          <Text style={styles.btnText}>Save putaway</Text>
        </Pressable>
        {localPreview ? (
          <View style={styles.preview}>
            <Text style={styles.previewTitle}>Local file (tail)</Text>
            <Text style={styles.previewTxt}>{localPreview}</Text>
          </View>
        ) : null}
      </ScrollView>
    );
  }

  if (mode === 'items' && batchDetail) {
    return (
      <View style={styles.flex}>
        <Pressable
          onPress={() => {
            setMode('batches');
            setBatchDetail(null);
            setActiveBatchId(null);
            setItemPartQuery('');
          }}
          style={styles.back}
        >
          <Text style={styles.backText}>← Batches</Text>
        </Pressable>
        <Text style={styles.h}>{batchDetail.batch.batch_name}</Text>
        <Text style={styles.meta}>{batchDetail.batch.vendor_name || ''}</Text>
        <Text style={styles.searchLabel}>Search by part # (or text in description)</Text>
        <TextInput
          style={styles.searchInput}
          value={itemPartQuery}
          onChangeText={setItemPartQuery}
          placeholder="e.g. ER8202 or cable"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {itemPartQuery.trim() ? (
          <Text style={styles.searchMeta}>
            {filteredBatchItems.length} of {batchDetail.items.length} line(s)
          </Text>
        ) : null}
        {loading ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
        <FlatList
          data={filteredBatchItems}
          keyExtractor={(it) => String(it.id)}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListEmptyComponent={
            <Text style={styles.emptySearch}>
              {batchDetail.items.length === 0
                ? 'No lines in this batch.'
                : 'No parts match your search. Clear the search or try another part number.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => openPutaway(item)}>
              <Text style={styles.part}>{item.part_number}</Text>
              <Text style={styles.small} numberOfLines={2}>
                {item.description || '—'}
              </Text>
              <View style={styles.stats}>
                <Text style={styles.small}>Tot {item.total_qty}</Text>
                <Text style={styles.small}>Put {item.putaway_qty}</Text>
                <Text style={styles.small}>Rem {item.remaining_qty}</Text>
                <Text style={styles.badge}>{item.status}</Text>
              </View>
            </Pressable>
          )}
        />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <Text style={styles.h}>Receiving</Text>
      <Text style={styles.sub}>Inbound batches — tap to put away to racks</Text>
      <View style={styles.toolbar}>
        <Pressable style={styles.tbSec} onPress={loadBatches}>
          <Text style={styles.tbSecText}>Refresh</Text>
        </Pressable>
        <Pressable style={styles.tbSec} onPress={shareLocal}>
          <Text style={styles.tbSecText}>Share local log</Text>
        </Pressable>
        <Pressable
          style={styles.tbSec}
          onPress={() => {
            clearPutawaySessionFile();
            setLocalPreview('');
            Alert.alert('Cleared', 'Local putaway session file cleared');
          }}
        >
          <Text style={styles.tbSecText}>Clear local file</Text>
        </Pressable>
      </View>
      {loading ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
      <FlatList
        data={batches}
        keyExtractor={(b) => String(b.id)}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={
          !loading ? <Text style={styles.empty}>No inbound batches. Upload inbound on web first.</Text> : null
        }
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => openBatch(item.id)}>
            <Text style={styles.batchTitle}>
              {item.batch_name}
              {item.vendor_name ? ` | ${item.vendor_name}` : ''}
            </Text>
            <Text style={styles.small}>
              {item.upload_date || '—'} · {item.status} · {item.item_count ?? '?'} parts · Rem Σ {item.sum_remaining ?? '—'}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 48 },
  wrap: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 48 },
  h: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  sub: { fontSize: 12, color: '#64748b', marginBottom: 10 },
  meta: { fontSize: 13, color: '#475569', marginBottom: 8 },
  back: { marginBottom: 8 },
  backText: { fontSize: 14, fontWeight: '700', color: '#2563eb' },
  batchTitle: { fontSize: 16, fontWeight: '800', color: '#0f172a' },
  part: { fontSize: 18, fontWeight: '800', color: '#1e293b', marginTop: 8 },
  desc: { fontSize: 13, color: '#64748b', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  k: { fontSize: 13, color: '#64748b' },
  v: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  label: { fontSize: 11, fontWeight: '700', color: '#475569', marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 48,
    marginTop: 4,
    backgroundColor: '#fff',
    color: '#0f172a',
    fontSize: 16,
  },
  btn: { backgroundColor: '#2563eb', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 16 },
  btnText: { color: '#fff', fontWeight: '800' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  small: { fontSize: 12, color: '#64748b', marginTop: 4 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  badge: { fontSize: 11, fontWeight: '800', color: '#1d4ed8' },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  tbSec: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  tbSecText: { fontWeight: '700', fontSize: 11, color: '#334155' },
  empty: { textAlign: 'center', color: '#94a3b8', marginTop: 24, fontSize: 13 },
  searchLabel: { fontSize: 11, fontWeight: '700', color: '#475569', marginTop: 4 },
  searchInput: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 46,
    marginTop: 6,
    backgroundColor: '#fff',
    fontSize: 16,
    color: '#0f172a',
  },
  searchMeta: { fontSize: 12, color: '#64748b', marginTop: 6 },
  emptySearch: { textAlign: 'center', color: '#94a3b8', marginTop: 20, fontSize: 13, paddingHorizontal: 8 },
  preview: { marginTop: 16, padding: 10, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
  previewTitle: { fontWeight: '700', marginBottom: 6, fontSize: 12 },
  previewTxt: { fontFamily: 'Courier', fontSize: 9, color: '#334155' },
});
