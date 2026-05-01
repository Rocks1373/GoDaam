import { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import * as Sharing from 'expo-sharing';
import {
  appendRackScanRow,
  clearLocalScanFile,
  readSessionFile,
  resetSessionFile,
  getSessionUri,
} from '../storage/localScanFileStorage';

export default function ScanRackScreen() {
  const [part, setPart] = useState('');
  const [sap, setSap] = useState('');
  const [desc, setDesc] = useState('');
  const [rack, setRack] = useState('');
  const [qty, setQty] = useState('');
  const [remarks, setRemarks] = useState('-');
  const [savedPreview, setSavedPreview] = useState('');
  const refRack = useRef<TextInput>(null);
  const refQty = useRef<TextInput>(null);

  useEffect(() => {
    setSap((prev) => (prev.trim() === '' ? part.trim() : prev));
  }, [part]);

  const canSave = part.trim().length > 0 && rack.trim().length > 0 && qty.trim().length > 0 && Number(qty) > 0;

  const onSave = async () => {
    if (!canSave) return;
    const today = new Date().toISOString().slice(0, 10);
    const pn = part.trim();
    const sapVal = sap.trim() || pn;
    await appendRackScanRow({
      transaction_date: today,
      part_number: pn,
      sap_part_number: sapVal,
      description: desc.trim() || '-',
      rack_location: rack.trim(),
      qty_in: Number(qty),
      source_type: 'rack_scan',
      reference_no: 'RACKSCAN001',
      remarks: remarks.trim() || '-',
    });
    const txt = await readSessionFile();
    setSavedPreview(txt.slice(-800));
    Alert.alert('Saved', 'Row appended to local TXT');
  };

  const shareFile = async () => {
    const uri = await getSessionUri();
    if (!uri) {
      Alert.alert('Nothing to share yet');
      return;
    }
    const ok = await Sharing.isAvailableAsync();
    if (!ok) {
      Alert.alert('Sharing not available');
      return;
    }
    await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle: 'Share rack scan' });
  };

  const clearFile = async () => {
    await clearLocalScanFile();
    resetSessionFile();
    setSavedPreview('');
    Alert.alert('Cleared');
  };

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.h}>Scan Rack</Text>
      <Text style={styles.note}>Barcode/OCR can fill Part Number; SAP defaults to Part until edited.</Text>

      <View style={styles.toolbar}>
        <Pressable style={[styles.tb, !canSave && styles.tbDisabled]} disabled={!canSave} onPress={onSave}>
          <Text style={styles.tbText}>Save scan</Text>
        </Pressable>
        <Pressable style={styles.tbSec} onPress={shareFile}>
          <Text style={styles.tbSecText}>Share TXT</Text>
        </Pressable>
        <Pressable style={styles.tbSec} onPress={clearFile}>
          <Text style={styles.tbSecText}>Clear file</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Part Number</Text>
      <TextInput style={styles.input} value={part} onChangeText={setPart} placeholder="Scan part" />

      <Text style={styles.label}>SAP Part Number</Text>
      <TextInput style={styles.input} value={sap} onChangeText={setSap} placeholder="Same as part if blank" />

      <Text style={styles.label}>Description</Text>
      <TextInput style={styles.input} value={desc} onChangeText={setDesc} />

      <Text style={styles.label}>Rack Location</Text>
      <TextInput
        ref={refRack}
        style={styles.input}
        value={rack}
        onChangeText={setRack}
        placeholder="Enter rack, press Next"
        onSubmitEditing={() => refQty.current?.focus()}
        returnKeyType="next"
      />

      <Text style={styles.label}>Qty</Text>
      <TextInput ref={refQty} style={styles.input} value={qty} onChangeText={setQty} keyboardType="decimal-pad" />

      <Text style={styles.label}>Remarks</Text>
      <TextInput style={styles.input} value={remarks} onChangeText={setRemarks} />

      {savedPreview ? (
        <View style={styles.previewBox}>
          <Text style={styles.previewTitle}>Saved rows (tail)</Text>
          <Text style={styles.preview}>{savedPreview}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 48 },
  h: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  note: { fontSize: 11, color: '#64748b', marginVertical: 8 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
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
  label: { fontSize: 11, fontWeight: '700', color: '#475569', marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    backgroundColor: '#fff',
  },
  previewBox: {
    marginTop: 16,
    padding: 10,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  previewTitle: { fontWeight: '700', marginBottom: 6 },
  preview: { fontFamily: 'Courier', fontSize: 10, color: '#334155' },
});
