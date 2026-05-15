import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  KeyboardAvoidingView,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
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
import { PartSuggestInput, type PartSuggestRow } from '../components/StockSuggestFields';
import { suggestMainStockForMobile } from '../api/stockLookupApi';
import {
  DEFAULT_SCAN_ROI,
  isBarcodeCenterInRoi,
  type ScanRoi,
} from '../utils/scanRoi';
import {
  appendRackScanRow,
  clearLocalScanFile,
  resetSessionFile,
  getSessionUri,
  getScanLogTxtBasename,
  loadSessionRowsNewestFirst,
  updateRackScanRow,
  type RackScanRowPersisted,
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

/** Ask backend for enough rows so the dropdown can show ~30+ matches when stock has them. */
const PART_SUGGEST_LIMIT = 40;

/** Positive finite number only — letters or junk yield null so Save stays off until qty is valid. */
function parsePositiveQty(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export default function ScanRackScreen() {
  const navigation = useNavigation();
  const [part, setPart] = useState('');
  const [sap, setSap] = useState('');
  const [rack, setRack] = useState('');
  const [qty, setQty] = useState('');
  const [remarks, setRemarks] = useState('-');
  const [savedRows, setSavedRows] = useState<RackScanRowPersisted[]>([]);
  const [editTarget, setEditTarget] = useState<RackScanRowPersisted | null>(null);
  const [editPart, setEditPart] = useState('');
  const [editSap, setEditSap] = useState('');
  const [editRack, setEditRack] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editRemarks, setEditRemarks] = useState('');
  const [editDate, setEditDate] = useState('');
  const refRack = useRef<TextInput>(null);
  const refQty = useRef<TextInput>(null);
  const sapUserEdited = useRef(false);

  const [perm, requestPerm] = useCameraPermissions();
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  /** True only after "Scan Now" until one barcode is accepted into `detectedCode`. */
  const [scanRequested, setScanRequested] = useState(false);
  const [detectedCode, setDetectedCode] = useState('');
  const scanRequestedRef = useRef(false);
  const scanLockedRef = useRef(false);
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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: !(barcodeOpen || ocrOpen),
    });
  }, [navigation, barcodeOpen, ocrOpen]);

  useEffect(() => {
    if (!sapUserEdited.current) {
      setSap(part.trim());
    }
  }, [part]);

  useEffect(() => {
    scanRequestedRef.current = scanRequested;
  }, [scanRequested]);

  const resetBarcodeModal = useCallback(() => {
    setScanRequested(false);
    scanRequestedRef.current = false;
    setDetectedCode('');
    scanLockedRef.current = false;
    lastBarcodeAt.current = 0;
  }, []);

  useEffect(() => {
    if (!barcodeOpen) resetBarcodeModal();
  }, [barcodeOpen, resetBarcodeModal]);

  useEffect(() => {
    if (!barcodeOpen && !ocrOpen) {
      setCameraReady(false);
    }
  }, [barcodeOpen, ocrOpen]);

  const refreshSavedRows = useCallback(async () => {
    try {
      const rows = await loadSessionRowsNewestFirst();
      setSavedRows(rows);
    } catch {
      setSavedRows([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshSavedRows();
    }, [refreshSavedRows])
  );

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
    resetBarcodeModal();
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
    if (!scanRequestedRef.current) return;
    if (scanLockedRef.current) return;
    const { width: pw, height: ph } = previewLayoutRef.current;
    if (!isBarcodeCenterInRoi(result.bounds, pw, ph, roiRef.current)) {
      return;
    }
    const now = Date.now();
    if (now - lastBarcodeAt.current < 400) return;
    lastBarcodeAt.current = now;
    const data = result.data?.trim();
    if (!data) return;
    scanLockedRef.current = true;
    scanRequestedRef.current = false;
    setScanRequested(false);
    setDetectedCode(data);
    setTimeout(() => {
      scanLockedRef.current = false;
    }, 1500);
  }, []);

  const onPressScanNow = useCallback(() => {
    setDetectedCode('');
    setScanRequested(true);
    scanRequestedRef.current = true;
    scanLockedRef.current = false;
    lastBarcodeAt.current = 0;
  }, []);

  const onPressRescan = useCallback(() => {
    setDetectedCode('');
    setScanRequested(false);
    scanRequestedRef.current = false;
    scanLockedRef.current = false;
    lastBarcodeAt.current = 0;
  }, []);

  const onPressUseThisCode = useCallback(() => {
    const code = detectedCode.trim();
    if (!code) return;
    setPart(code);
    if (!sap.trim()) {
      sapUserEdited.current = false;
      setSap(code);
    }
    resetBarcodeModal();
    setBarcodeOpen(false);
    setTimeout(() => refRack.current?.focus(), 150);
  }, [detectedCode, sap, resetBarcodeModal]);

  const fetchPartSuggest = useCallback(
    (q: string) => suggestMainStockForMobile(q, PART_SUGGEST_LIMIT),
    []
  );

  const onPickPartFromStock = useCallback((row: PartSuggestRow) => {
    const s = String(row.sap_part_number ?? row.part_number).trim();
    sapUserEdited.current = true;
    setSap(s.length ? s : row.part_number.trim());
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
        sapUserEdited.current = false;
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
    sapUserEdited.current = false;
    setPart(line);
    setOcrLinesOpen(false);
    setOcrCandidates([]);
  };

  const qtyParsed = parsePositiveQty(qty);
  const canSave =
    part.trim().length > 0 && rack.trim().length > 0 && qty.trim().length > 0 && qtyParsed != null;
  const qtyInvalidHint =
    part.trim().length > 0 && rack.trim().length > 0 && qty.trim().length > 0 && qtyParsed == null
      ? 'Quantity must be a number greater than zero (e.g. 1, 10, or 2.5). Letters are not accepted.'
      : null;

  const onSave = async () => {
    if (!canSave || qtyParsed == null) return;
    const today = new Date().toISOString().slice(0, 10);
    const pn = part.trim();
    const sapVal = sap.trim() || pn;
    await appendRackScanRow({
      transaction_date: today,
      part_number: pn,
      sap_part_number: sapVal,
      rack_location: rack.trim(),
      qty_in: qtyParsed,
      source_type: 'rack_scan',
      reference_no: 'RACKSCAN001',
      remarks: remarks.trim() || '-',
    });
    await refreshSavedRows();
    sapUserEdited.current = false;
    setPart('');
    setSap('');
    setRack('');
    setQty('');
    setRemarks('-');
    Alert.alert('Saved', `Appended to ${getScanLogTxtBasename()}. Nothing is removed until you tap Clear all.`);
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

  const clearFile = () => {
    Alert.alert(
      'Clear all rack scans?',
      'This removes every saved line from this device (local session + text log). You cannot undo this.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            await clearLocalScanFile();
            resetSessionFile();
            setSavedRows([]);
            Alert.alert('Cleared', 'All rack scan data was removed from this device.');
          },
        },
      ]
    );
  };

  const openEdit = (row: RackScanRowPersisted) => {
    setEditTarget(row);
    setEditPart(row.part_number);
    setEditSap(row.sap_part_number);
    setEditRack(row.rack_location);
    setEditQty(String(row.qty_in));
    setEditRemarks(row.remarks || '-');
    setEditDate(row.transaction_date);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const pn = editPart.trim();
    const reg = editSap.trim();
    const rk = editRack.trim();
    const qn = Number(editQty);
    if (!pn) {
      Alert.alert('Part number required');
      return;
    }
    if (!rk) {
      Alert.alert('Rack location required');
      return;
    }
    if (!editQty.trim() || !Number.isFinite(qn) || qn <= 0) {
      Alert.alert('Quantity required', 'Enter a quantity greater than zero.');
      return;
    }
    try {
      await updateRackScanRow(editTarget.id, {
        part_number: pn,
        sap_part_number: reg || pn,
        rack_location: rk,
        qty_in: qn,
        remarks: editRemarks.trim() || '-',
        transaction_date: editDate.trim() || editTarget.transaction_date,
      });
      setEditTarget(null);
      await refreshSavedRows();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Update failed';
      Alert.alert('Error', msg);
    }
  };

  const nativeScanNote =
    Platform.OS === 'web'
      ? 'Barcode and OCR run on iOS/Android device or dev builds — not in the browser.'
      : 'Barcode: open scanner, tap Capture barcode, then aim — scanning is off until you capture (same idea as OCR). OCR reads text in the blue frame using on-device AI when available, or your warehouse server otherwise.';

  const ocrHint = getOcrUnavailableHint();
  const ocrEnabled = Platform.OS !== 'web';
  const ocrServerHint =
    Platform.OS !== 'web' && !isOcrNativeUsable()
      ? `OCR via server (${getDisplayApiOrigin()}) — backend must be running.`
      : null;

  return (
    <ScrollView
      style={styles.wrap}
      contentContainerStyle={{ paddingBottom: 32 }}
      keyboardShouldPersistTaps="handled"
    >
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
          <Text style={styles.tbSecText}>Clear all</Text>
        </Pressable>
      </View>
      <Text style={styles.persistNote}>
        Scans are kept in <Text style={styles.persistBold}>{getScanLogTxtBasename()}</Text> on this device. Lines are not
        removed automatically — use <Text style={styles.persistBold}>Clear all</Text> only when you want to wipe everything.
        Use <Text style={styles.persistBold}>Share TXT</Text> to send the file.
      </Text>

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
      <PartSuggestInput
        wrapStyle={styles.partSuggestWrap}
        value={part}
        onChangeText={setPart}
        fetchSuggest={fetchPartSuggest}
        onPick={onPickPartFromStock}
        placeholder="Scan, type for suggestions (main stock), or pick a row"
        returnKeyType="next"
        onSubmitEditing={() => refRack.current?.focus()}
      />

      <Text style={styles.label}>SAP Part Number</Text>
      <TextInput
        style={styles.input}
        value={sap}
        onChangeText={(t) => {
          sapUserEdited.current = true;
          setSap(t);
        }}
        placeholder="Matches part until you edit this field"
        placeholderTextColor="#94a3b8"
      />

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
      <TextInput
        ref={refQty}
        style={[styles.input, qtyInvalidHint ? styles.inputWarn : null]}
        value={qty}
        onChangeText={setQty}
        keyboardType="decimal-pad"
        placeholder="Number only, e.g. 5"
        placeholderTextColor="#94a3b8"
      />
      {qtyInvalidHint ? <Text style={styles.fieldError}>{qtyInvalidHint}</Text> : null}

      <Text style={styles.label}>Remarks</Text>
      <TextInput style={styles.input} value={remarks} onChangeText={setRemarks} placeholderTextColor="#94a3b8" />

      <View style={styles.savedSection}>
        <Text style={styles.savedSectionTitle}>Saved scans (newest at top)</Text>
        {savedRows.length === 0 ? (
          <Text style={styles.savedEmpty}>
            After you tap Save scan, lines appear here. Use Edit to correct a line. Entries stay until you tap Clear all.
          </Text>
        ) : (
          savedRows.map((item) => (
            <View key={item.id} style={styles.savedCard}>
              <View style={styles.savedCardMain}>
                <Text style={styles.savedPart} numberOfLines={2}>
                  {item.part_number}
                </Text>
                <Text style={styles.savedMeta}>
                  Reg / SAP: {item.sap_part_number || '—'} · Rack {item.rack_location} · Qty {item.qty_in}
                </Text>
                {item.remarks && item.remarks !== '-' ? (
                  <Text style={styles.savedRemarks} numberOfLines={2}>
                    {item.remarks}
                  </Text>
                ) : null}
                <Text style={styles.savedDate}>{item.transaction_date}</Text>
              </View>
              <View style={styles.savedActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit scan ${item.part_number}`}
                  style={styles.savedBtnEdit}
                  onPress={() => openEdit(item)}
                >
                  <Ionicons name="pencil" size={16} color="#1d4ed8" />
                  <Text style={styles.savedBtnEditText}>Edit</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </View>

      <Modal visible={!!editTarget} transparent animationType="fade" onRequestClose={() => setEditTarget(null)}>
        <KeyboardAvoidingView
          style={styles.editKb}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={styles.editOverlay} onPress={() => setEditTarget(null)}>
            <Pressable style={styles.editCard} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.editTitle}>Edit scan line</Text>
              <ScrollView
                style={styles.editScroll}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.editLabel}>Part number</Text>
                <TextInput
                  style={styles.input}
                  value={editPart}
                  onChangeText={setEditPart}
                  placeholder="Part number"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="characters"
                />
                <Text style={styles.editLabel}>Reg / SAP number</Text>
                <TextInput
                  style={styles.input}
                  value={editSap}
                  onChangeText={setEditSap}
                  placeholder="Same as part if blank"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="characters"
                />
                <Text style={styles.editLabel}>Rack location</Text>
                <TextInput
                  style={styles.input}
                  value={editRack}
                  onChangeText={setEditRack}
                  placeholder="Rack"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="characters"
                />
                <Text style={styles.editLabel}>Quantity</Text>
                <TextInput
                  style={styles.input}
                  value={editQty}
                  onChangeText={setEditQty}
                  keyboardType="decimal-pad"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.editLabel}>Transaction date</Text>
                <TextInput
                  style={styles.input}
                  value={editDate}
                  onChangeText={setEditDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#94a3b8"
                />
                <Text style={styles.editLabel}>Remarks</Text>
                <TextInput
                  style={styles.input}
                  value={editRemarks}
                  onChangeText={setEditRemarks}
                  placeholder="Remarks"
                  placeholderTextColor="#94a3b8"
                />
              </ScrollView>
              <View style={styles.editToolbar}>
                <Pressable style={styles.tbSec} onPress={() => setEditTarget(null)}>
                  <Text style={styles.tbSecText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.tb} onPress={() => void saveEdit()}>
                  <Text style={styles.tbText}>Save</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={barcodeOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent
        onRequestClose={() => {
          resetBarcodeModal();
          setBarcodeOpen(false);
        }}
      >
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Scan barcode</Text>
            <Pressable
              onPress={() => {
                resetBarcodeModal();
                setBarcodeOpen(false);
              }}
              hitSlop={12}
            >
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>
          <View style={styles.cameraSectionFull}>
            <View
              style={styles.cameraInner}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                previewLayoutRef.current = { width, height };
              }}
            >
              <CameraView
                style={StyleSheet.absoluteFillObject}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: scanRequested ? BARCODE_TYPES : ([] as BarcodeType[]),
                }}
                onBarcodeScanned={scanRequested ? onBarcodeScanned : undefined}
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
            <Pressable style={[styles.captureBtn, scanRequested && styles.captureBtnScanning]} onPress={onPressScanNow}>
              <Ionicons name="scan-outline" size={22} color="#fff" />
              <Text style={styles.captureBtnText}>Scan Now</Text>
            </Pressable>
            <View style={styles.detectedCodeBox}>
              <Text style={styles.detectedCodeLabel}>Detected Code:</Text>
              <Text style={styles.detectedCodeValue} numberOfLines={3} selectable>
                {detectedCode.trim() ? detectedCode : '______'}
              </Text>
            </View>
            <Pressable
              style={[styles.useCodeBtn, !detectedCode.trim() && styles.useCodeBtnDisabled]}
              disabled={!detectedCode.trim()}
              onPress={onPressUseThisCode}
            >
              <Ionicons name="checkmark-circle-outline" size={22} color="#fff" />
              <Text style={styles.captureBtnText}>Use This Code</Text>
            </Pressable>
            <Pressable style={[styles.tbSec, styles.rescanBtn]} onPress={onPressRescan}>
              <Text style={styles.tbSecText}>Rescan</Text>
            </Pressable>
            <Text style={styles.modalHint}>
              Nothing is read until you tap Scan Now. Align the barcode inside the blue rectangle, then tap Scan Now once.
              Use This Code fills Part Number and focuses Rack Location. Rescan clears the result so you can tap Scan Now
              again.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={ocrOpen} animationType="slide" presentationStyle="fullScreen" statusBarTranslucent onRequestClose={() => setOcrOpen(false)}>
        <SafeAreaView style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>OCR part label</Text>
            <Pressable onPress={() => setOcrOpen(false)} hitSlop={12}>
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>
          <View style={styles.cameraSectionFull}>
            <View
              style={styles.cameraInner}
              onLayout={(e) => {
                const { width, height } = e.nativeEvent.layout;
                previewLayoutRef.current = { width, height };
              }}
            >
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFillObject}
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
  persistNote: {
    fontSize: 11,
    color: '#475569',
    lineHeight: 16,
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  persistBold: { fontWeight: '800', color: '#0f172a' },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
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
  partSuggestWrap: { zIndex: 20, marginTop: 4 },
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
  inputWarn: { borderColor: '#f97316', backgroundColor: '#fff7ed' },
  fieldError: { fontSize: 12, color: '#c2410c', marginTop: 6, fontWeight: '600', lineHeight: 16 },
  savedSection: { marginTop: 16 },
  savedSectionTitle: { fontSize: 12, fontWeight: '800', color: '#0f172a', marginBottom: 8 },
  savedEmpty: { fontSize: 12, color: '#64748b', lineHeight: 17, marginBottom: 8 },
  savedCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    padding: 12,
    marginBottom: 8,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  savedCardMain: { flex: 1, minWidth: 0 },
  savedPart: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  savedMeta: { fontSize: 11, color: '#475569', marginTop: 4, lineHeight: 15 },
  savedDate: { fontSize: 10, color: '#94a3b8', marginTop: 4 },
  savedRemarks: { fontSize: 11, color: '#475569', marginTop: 4, fontStyle: 'italic' },
  savedActions: { flexDirection: 'row', alignItems: 'flex-start' },
  savedBtnEdit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  savedBtnEditText: { fontSize: 11, fontWeight: '800', color: '#1d4ed8' },
  editKb: { flex: 1 },
  editOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  editCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    maxHeight: '88%',
  },
  editScroll: { maxHeight: 420 },
  editTitle: { fontSize: 17, fontWeight: '800', color: '#0f172a', marginBottom: 12 },
  editLabel: { fontSize: 11, fontWeight: '700', color: '#475569', marginTop: 8 },
  editToolbar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
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
  cameraSectionFull: {
    flex: 1,
    marginHorizontal: 0,
    minHeight: 120,
  },
  cameraInner: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#020617',
  },
  modalScroll: { flexGrow: 0, maxHeight: '42%', minHeight: 0 },
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
  captureBtnScanning: { backgroundColor: '#15803d', borderWidth: 2, borderColor: '#22c55e' },
  captureBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  detectedCodeBox: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  detectedCodeLabel: { fontSize: 12, fontWeight: '700', color: '#94a3b8', marginBottom: 6 },
  detectedCodeValue: { fontSize: 16, fontWeight: '800', color: '#f8fafc', minHeight: 24 },
  useCodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 10,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#059669',
  },
  useCodeBtnDisabled: { opacity: 0.45, backgroundColor: '#475569' },
  rescanBtn: { marginTop: 10, alignSelf: 'stretch' },
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
