import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView } from 'react-native';
import { receiving } from '../api/stockApi';

export default function ReceivingScreen() {
  const [rack, setRack] = useState('');
  const [part, setPart] = useState('');
  const [sap, setSap] = useState('');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('');
  const [refNo, setRefNo] = useState('');
  const [remarks, setRemarks] = useState('');

  const save = async () => {
    try {
      await receiving({
        scan_rack: rack.trim(),
        part_number: part.trim(),
        sap_part_number: sap.trim() || undefined,
        description: desc.trim(),
        qty_in: Number(qty),
        reference_no: refNo.trim(),
        remarks: remarks.trim(),
      });
      Alert.alert('Receiving saved');
      setQty('');
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      Alert.alert('Failed', err.response?.data?.error || 'Error');
    }
  };

  const ok = rack.trim() && part.trim() && Number(qty) > 0;

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={styles.h}>Receiving</Text>
      <TextInput style={styles.input} placeholder="Scan Rack" value={rack} onChangeText={setRack} />
      <TextInput style={styles.input} placeholder="Part Number" value={part} onChangeText={setPart} />
      <TextInput style={styles.input} placeholder="SAP Part Number" value={sap} onChangeText={setSap} />
      <TextInput style={styles.input} placeholder="Description" value={desc} onChangeText={setDesc} />
      <TextInput style={styles.input} placeholder="Qty In" value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
      <TextInput style={styles.input} placeholder="Reference No" value={refNo} onChangeText={setRefNo} />
      <TextInput style={styles.input} placeholder="Remarks" value={remarks} onChangeText={setRemarks} />
      <Pressable style={[styles.btn, !ok && styles.off]} disabled={!ok} onPress={save}>
        <Text style={styles.btnText}>Save</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 48 },
  h: { fontSize: 22, fontWeight: '800', marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  btn: { backgroundColor: '#2563eb', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  off: { opacity: 0.45 },
  btnText: { color: '#fff', fontWeight: '700' },
});
