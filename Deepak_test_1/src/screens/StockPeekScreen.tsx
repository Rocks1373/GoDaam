import { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from './LoginScreen';
import { getOrderStockOverview, type StockOverviewLine } from '../api/ordersApi';

type Props = NativeStackScreenProps<RootStackParamList, 'StockPeek'>;

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return String(v);
}

export default function StockPeekScreen({ route }: Props) {
  const { orderId, outboundItemId } = route.params;
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState<StockOverviewLine | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const ov = await getOrderStockOverview(orderId);
        const found = (ov.lines || []).find((l) => Number(l.outbound_item_id) === Number(outboundItemId)) || null;
        if (!cancelled) setLine(found);
      } catch {
        if (!cancelled) setLine(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, outboundItemId]);

  const racks = useMemo(() => line?.racks || [], [line]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  if (!line) {
    return (
      <View style={styles.center}>
        <Text style={styles.err}>Line not found or no access.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.banner}>Read-only reference. Use the web app to edit stock, racks, or picks.</Text>

      <View style={styles.card}>
        <Text style={styles.h}>Part</Text>
        <Text style={styles.val}>{line.material || line.part_number}</Text>
        <Text style={styles.sub}>Part # {line.part_number}</Text>
        {line.description ? <Text style={styles.sub}>{line.description}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>SAP & vendor</Text>
        <Row label="SAP part #" value={fmt(line.sap_part_number)} />
        <Row label="Vendor number" value={fmt(line.vendor_number)} />
        <Row label="Vendor name" value={fmt(line.vendor_name)} />
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Pick line</Text>
        <Row label="Required" value={fmt(line.required_qty)} />
        <Row label="Picked (effective)" value={fmt(line.picked_qty_effective)} />
        <Row label="Remaining" value={fmt(line.remaining_qty)} />
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Main stock</Text>
        {!line.main_stock ? (
          <Text style={styles.muted}>No main stock row for this part number.</Text>
        ) : (
          <>
            <Row label="Available" value={fmt(line.main_stock.available_qty)} />
            <Row label="Received" value={fmt(line.main_stock.received_qty)} />
            <Row label="Sold / issued" value={fmt(line.main_stock.sold_out_qty)} />
            <Row label="Pending delivery" value={fmt(line.main_stock.pending_delivery_qty)} />
            <Row label="UOM" value={fmt(line.main_stock.uom)} />
            {line.main_stock.remarks ? (
              <Text style={styles.remarks}>Remarks: {String(line.main_stock.remarks)}</Text>
            ) : null}
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.h}>Stock by rack ({racks.length})</Text>
        {!racks.length ? (
          <Text style={styles.muted}>No rack rows for this part (or filter cleared them on the order screen).</Text>
        ) : (
          racks.map((r, idx) => {
            const row = r as Record<string, unknown>;
            return (
              <View key={row.id != null ? String(row.id) : `rack-${idx}`} style={styles.rackRow}>
                <Text style={styles.rackLoc}>{fmt(row.rack_location)}</Text>
                <Text style={styles.rackSub}>
                  Avail {fmt(row.available_qty)} · In {fmt(row.total_in_qty)} · Out {fmt(row.total_out_qty)}
                </Text>
                {row.first_entry_date ? (
                  <Text style={styles.rackSub}>FIFO date: {fmt(row.first_entry_date)}</Text>
                ) : null}
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.lbl}>{label}</Text>
      <Text style={styles.val}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', paddingTop: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8fafc', padding: 24 },
  muted: { fontSize: 13, color: '#64748b', marginTop: 8 },
  err: { color: '#b91c1c', fontSize: 15 },
  banner: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    backgroundColor: '#eff6ff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#bfdbfe',
    fontSize: 12,
    color: '#1e40af',
    lineHeight: 17,
  },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  h: { fontSize: 11, fontWeight: '800', color: '#64748b', textTransform: 'uppercase', marginBottom: 8 },
  val: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  sub: { fontSize: 13, color: '#475569', marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginBottom: 8 },
  lbl: { fontSize: 13, color: '#64748b', flex: 1 },
  remarks: { fontSize: 12, color: '#475569', marginTop: 8, lineHeight: 18 },
  rackRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  rackLoc: { fontSize: 15, fontWeight: '700', color: '#0f172a' },
  rackSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
});
