import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  Modal,
  ActivityIndicator,
  Platform,
  SafeAreaView,
  useWindowDimensions,
} from 'react-native';
import * as Sharing from 'expo-sharing';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeType,
} from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { extractTextFromImageSafe, getOcrUnavailableHint, isOcrNativeUsable } from '../utils/ocrOptional';
import { extractTextRemote } from '../api/ocrApi';
import { getDisplayApiOrigin } from '../api/client';
import { ScanRoiOverlay } from '../components/ScanRoiOverlay';
import { ScanRoiToolbar } from '../components/ScanRoiToolbar';
import {
  DEFAULT_SCAN_ROI,
  isBarcodeCenterInRoi,
  type ScanRoi,
} from '../utils/scanRoi';
import {
  appendRackScanRow,
  clearLocalScanFile,
  readSessionFile,
  resetSessionFile,
  getSessionUri,
} from '../storage/localScanFileStorage';

/** Common warehouse / inventory symbologies */
const BARCODE_TYPES: BarcodeType[] = [
  'code128',
  'code39',
  'code93',
  'codabar',
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'itf14',
  'qr',
  'pdf417',
  'datamatrix',
  'aztec',
];

function buildPartCandidates(blocks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokenRe = /^[A-Z0-9][A-Z0-9\-._/]{2,}$/i;

  const push = (s: string) => {
    const t = s.trim().replace(/\s{2,}/g, ' ');
    if (t.length < 3 || t.length > 80) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  for (const block of blocks) {
    const parts = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of parts.length ? parts : [block]) {
      const compact = line.replace(/\s+/g, '');
      if (tokenRe.test(compact)) push(line);
    }
  }

  if (out.length === 0) {
    for (const block of blocks) {
      for (const line of block.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length >= 2) push(t);
        if (out.length >= 15) return out;
      }
    }
  }

  return out.slice(0, 15);
}

export default function ScanRackScreen() {
  const [part, setPart] = useState('');
  const [sap, setSap] = useState('');
  const [rack, setRack] = useState('');
  const [qty, setQty] = useState('');
  const [remarks, setRemarks] = useState('-');
  const [savedPreview, setSavedPreview] = useState('');
  const refRack = useRef<TextInput>(null);
  const refQty = useRef<TextInput>(null);

  const [perm, requestPerm] = useCameraPermissions();
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrLinesOpen, setOcrLinesOpen] = useState(false);
  const [ocrCandidates, setOcrCandidates] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [roi, setRoi] = useState<ScanRoi>(DEFAULT_SCAN_ROI);
  const lastBarcodeAt = useRef(0);
  const cameraRef = useRef<InstanceType<typeof CameraView> | null>(null);
  const previewLayoutRef = useRef({ width: 0, height: 0 });
  const roiRef = useRef(roi);
  roiRef.current = roi;

  const { height: windowH } = useWindowDimensions();
  const previewBlockHeight = Math.min(windowH * 0.44, 400);

  useEffect(() => {
    setSap((prev) => (prev.trim() === '' ? part.trim() : prev));
  }, [part]);

  useEffect(() => {
    if (!barcodeOpen && !ocrOpen) {
      setCameraReady(false);
    }
  }, [barcodeOpen, ocrOpen]);

  const ensureCameraPermission = useCallback(async () => {
    if (perm?.granted) return true;
    const r = await requestPerm();
    if (!r.granted) {
      Alert.alert('Camera required', 'Allow camera access to scan barcodes or capture labels for OCR.');
    }
    return r.granted;
  }, [perm?.granted, requestPerm]);

  const openBarcode = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not on web', 'Barcode scanning runs on iOS and Android builds.');
      return;
    }
    if (!(await ensureCameraPermission())) return;
    lastBarcodeAt.current = 0;
    setBarcodeOpen(true);
  };

  const openOcr = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Not on web', 'OCR runs on iOS and Android device builds.');
      return;
    }
    if (!(await ensureCameraPermission())) return;
    setCameraReady(false);
    setOcrOpen(true);
  };

  const onBarcodeScanned = useCallback((result: BarcodeScanningResult) => {
    const { width: pw, height: ph } = previewLayoutRef.current;
    if (!isBarcodeCenterInRoi(result.bounds, pw, ph, roiRef.current)) {
      return;
    }
    const now = Date.now();
    if (now - lastBarcodeAt.current < 900) return;
    lastBarcodeAt.current = now;
    const data = result.data?.trim();
    if (!data) return;
    setPart(data);
    setBarcodeOpen(false);
  }, []);

  const cropUriToRoi = async (uri: string, photoW: number, photoH: number, r: ScanRoi) => {
    let ox = Math.round(r.left * photoW);
    let oy = Math.round(r.top * photoH);
    let cw = Math.round(r.width * photoW);
    let ch = Math.round(r.height * photoH);
    ox = Math.max(0, Math.min(ox, photoW - 1));
    oy = Math.max(0, Math.min(oy, photoH - 1));
    cw = Math.max(1, Math.min(cw, photoW - ox));
    ch = Math.max(1, Math.min(ch, photoH - oy));
    const out = await manipulateAsync(
      uri,
      [{ crop: { originX: ox, originY: oy, width: cw, height: ch } }],
      { compress: 0.85, format: SaveFormat.JPEG }
    );
    return out.uri;
  };

  const runOcrCapture = async () => {
    if (!cameraRef.current || !cameraReady) return;
    setOcrBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85, shutterSound: false });
      const w = photo.width ?? 0;
      const h = photo.height ?? 0;
      const uri =
        w > 0 && h > 0 ? await cropUriToRoi(photo.uri, w, h, roiRef.current) : photo.uri;
      let texts: string[];
      if (isOcrNativeUsable()) {
        texts = await extractTextFromImageSafe(uri);
      } else {
        try {
          texts = await extractTextRemote(uri);
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } }; message?: string };
          const detail = err.response?.data?.error || err.message || 'Request failed';
          Alert.alert(
            'Server OCR failed',
            `Check that the warehouse backend is running and this device can reach your API (${getDisplayApiOrigin()}). Set Server setup / Profile if the URL changed.\n\n${detail}`
          );
          return;
        }
      }
      const candidates = buildPartCandidates(texts);
      setOcrOpen(false);
      if (candidates.length === 0) {
        Alert.alert('No text found', 'Try better lighting, hold steady, or enter the part manually.');
        return;
      }
      if (candidates.length === 1) {
        setPart(candidates[0]);
        return;
      }
      setOcrCandidates(candidates);
      setOcrLinesOpen(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'OCR failed';
      Alert.alert('OCR error', msg);
    } finally {
      setOcrBusy(false);
    }
  };

  const pickOcrLine = (line: string) => {
    setPart(line);
    setOcrLinesOpen(false);
    setOcrCandidates([]);
  };

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

  const nativeScanNote =
    Platform.OS === 'web'
      ? 'Barcode and OCR run on iOS/Android device or dev builds — not in the browser.'
      : 'Barcode reads codes inside the blue frame. OCR reads text in that frame using on-device AI when available, or your warehouse server (login required) otherwise.';

  const ocrHint = getOcrUnavailableHint();
  const ocrEnabled = Platform.OS !== 'web';
  const ocrServerHint =
    Platform.OS !== 'web' && !isOcrNativeUsable()
      ? `OCR via server (${getDisplayApiOrigin()}) — backend must be running.`
      : null;

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.h}>Scan Rack</Text>
      <Text style={styles.note}>{nativeScanNote}</Text>

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
      <View style={styles.scanRow}>
        <Pressable style={styles.scanBtn} onPress={openBarcode}>
          <Ionicons name="barcode-outline" size={20} color="#1d4ed8" />
          <Text style={styles.scanBtnText}>Barcode</Text>
        </Pressable>
        <Pressable style={styles.scanBtn} onPress={openOcr} disabled={!ocrEnabled}>
          <Ionicons name="text-outline" size={20} color="#1d4ed8" />
          <Text style={styles.scanBtnText}>OCR label</Text>
        </Pressable>
      </View>
      {ocrHint ? <Text style={styles.ocrInlineHint}>{ocrHint}</Text> : null}
      {ocrServerHint ? <Text style={styles.ocrInlineHint}>{ocrServerHint}</Text> : null}
      <TextInput style={styles.input} value={part} onChangeText={setPart} placeholder="Scan or type part number" placeholderTextColor="#94a3b8" />

      <Text style={styles.label}>SAP Part Number</Text>
      <TextInput style={styles.input} value={sap} onChangeText={setSap} placeholder="Same as part if blank" placeholderTextColor="#94a3b8" />

      <Text style={styles.label}>Rack Location</Text>
      <TextInput
        ref={refRack}
        style={styles.input}
        value={rack}
        onChangeText={setRack}
        placeholder="Enter rack, press Next"
        placeholderTextColor="#94a3b8"
        onSubmitEditing={() => refQty.current?.focus()}
        returnKeyType="next"
      />

      <Text style={styles.label}>Qty</Text>
      <TextInput ref={refQty} style={styles.input} value={qty} onChangeText={setQty} keyboardType="decimal-pad" placeholderTextColor="#94a3b8" />

      <Text style={styles.label}>Remarks</Text>
      <TextInput style={styles.input} value={remarks} onChangeText={setRemarks} placeholderTextColor="#94a3b8" />

      {savedPreview ? (
        <View style={styles.previewBox}>
          <Text style={styles.previewTitle}>Saved rows (tail)</Text>
          <Text style={styles.preview}>{savedPreview}</Text>
        </View>
      ) : null}

      <Modal visible={barcodeOpen} animationType="slide" onRequestClose={() => setBarcodeOpen(false)}>
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Scan barcode</Text>
            <Pressable onPress={() => setBarcodeOpen(false)} hitSlop={12}>
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>
          <View style={[styles.cameraSection, { height: previewBlockHeight }]}>
            <View
              style={styles.cameraInner}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                previewLayoutRef.current = { width, height };
              }}
            >
              <CameraView
                style={styles.cameraFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
                onBarcodeScanned={onBarcodeScanned}
              />
              <ScanRoiOverlay roi={roi} />
            </View>
          </View>
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <ScanRoiToolbar roi={roi} onChange={setRoi} />
            <Text style={styles.modalHint}>
              Only codes whose center falls inside the blue rectangle are accepted. Use Up/Down to move the box; Smaller/Larger
              and Narrower/Wider/Shorter/Taller to resize.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={ocrOpen} animationType="slide" onRequestClose={() => setOcrOpen(false)}>
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>OCR part label</Text>
            <Pressable onPress={() => setOcrOpen(false)} hitSlop={12}>
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>
          <View style={[styles.cameraSection, { height: previewBlockHeight }]}>
            <View
              style={styles.cameraInner}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                previewLayoutRef.current = { width, height };
              }}
            >
              <CameraView
                ref={cameraRef}
                style={styles.cameraFill}
                facing="back"
                onCameraReady={() => setCameraReady(true)}
              />
              <ScanRoiOverlay roi={roi} />
            </View>
          </View>
          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <ScanRoiToolbar roi={roi} onChange={setRoi} />
            <Pressable
              style={[styles.captureBtn, (!cameraReady || ocrBusy) && styles.captureBtnDisabled]}
              disabled={!cameraReady || ocrBusy}
              onPress={runOcrCapture}
            >
              {ocrBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="camera" size={22} color="#fff" />
                  <Text style={styles.captureBtnText}>Capture & read text (region only)</Text>
                </>
              )}
            </Pressable>
            <Text style={styles.modalHint}>
              Text is read only from the blue rectangle. Align the label there, adjust the box, then capture.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={ocrLinesOpen} transparent animationType="fade" onRequestClose={() => setOcrLinesOpen(false)}>
        <Pressable style={styles.pickOverlay} onPress={() => setOcrLinesOpen(false)}>
          <Pressable style={styles.pickCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.pickTitle}>Choose part number</Text>
            <ScrollView style={styles.pickList}>
              {ocrCandidates.map((line) => (
                <Pressable key={line} style={styles.pickRow} onPress={() => pickOcrLine(line)}>
                  <Text style={styles.pickRowText}>{line}</Text>
                  <Ionicons name="chevron-forward" size={18} color="#64748b" />
                </Pressable>
              ))}
            </ScrollView>
            <Pressable style={styles.pickCancel} onPress={() => setOcrLinesOpen(false)}>
              <Text style={styles.pickCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f8fafc', padding: 16, paddingTop: 48 },
  h: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  note: { fontSize: 11, color: '#64748b', marginVertical: 8, lineHeight: 15 },
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
  scanRow: { flexDirection: 'row', gap: 10, marginTop: 6, marginBottom: 6 },
  scanBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  scanBtnText: { fontSize: 14, fontWeight: '700', color: '#1d4ed8' },
  ocrInlineHint: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 6,
    marginBottom: 2,
    lineHeight: 15,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    backgroundColor: '#fff',
    color: '#0f172a',
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
  modalRoot: { flex: 1, backgroundColor: '#0f172a' },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexShrink: 0,
  },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#f8fafc' },
  modalClose: { fontSize: 16, fontWeight: '700', color: '#93c5fd' },
  cameraSection: {
    marginHorizontal: 12,
    flexShrink: 0,
  },
  cameraInner: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#020617',
  },
  cameraFill: { flex: 1 },
  modalScroll: { flex: 1 },
  modalScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
  },
  modalHint: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 12,
    lineHeight: 17,
  },
  captureBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 4,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#2563eb',
  },
  captureBtnDisabled: { opacity: 0.5 },
  captureBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  pickOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.65)',
    justifyContent: 'center',
    padding: 20,
  },
  pickCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    maxHeight: '70%',
    paddingTop: 16,
  },
  pickTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0f172a',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  pickList: { maxHeight: 320 },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e2e8f0',
  },
  pickRowText: { flex: 1, fontSize: 15, color: '#0f172a', fontWeight: '600', marginRight: 8 },
  pickCancel: { padding: 16, alignItems: 'center' },
  pickCancelText: { fontSize: 16, fontWeight: '700', color: '#64748b' },
});
