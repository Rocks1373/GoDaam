import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ScanRoi } from '../utils/scanRoi';
import {
  moveRoiVertical,
  scaleRoi,
  adjustRoiWidth,
  adjustRoiHeight,
} from '../utils/scanRoi';

type Props = {
  roi: ScanRoi;
  onChange: (next: ScanRoi) => void;
};

const STEP_Y = 0.035;
const SCALE = 1.09;
const EDGE = 0.04;

export function ScanRoiToolbar({ roi, onChange }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Scan area</Text>
      <Text style={styles.sub}>Only inside the blue rectangle is used. Adjust shape and position.</Text>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={() => onChange(moveRoiVertical(roi, -STEP_Y))}>
          <Ionicons name="chevron-up" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Up</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => onChange(moveRoiVertical(roi, STEP_Y))}>
          <Ionicons name="chevron-down" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Down</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={() => onChange(scaleRoi(roi, 1 / SCALE))}>
          <Ionicons name="contract-outline" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Smaller</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => onChange(scaleRoi(roi, SCALE))}>
          <Ionicons name="expand-outline" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Larger</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={() => onChange(adjustRoiWidth(roi, -EDGE))}>
          <Ionicons name="resize-outline" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Narrower</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => onChange(adjustRoiWidth(roi, EDGE))}>
          <Ionicons name="arrow-redo-outline" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Wider</Text>
        </Pressable>
      </View>

      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={() => onChange(adjustRoiHeight(roi, -EDGE))}>
          <Ionicons name="remove-outline" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Shorter</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={() => onChange(adjustRoiHeight(roi, EDGE))}>
          <Ionicons name="add-outline" size={22} color="#f8fafc" />
          <Text style={styles.btnLbl}>Taller</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginBottom: 4 },
  title: { fontSize: 14, fontWeight: '800', color: '#f1f5f9', marginBottom: 2 },
  sub: { fontSize: 11, color: '#94a3b8', marginBottom: 8, lineHeight: 15 },
  row: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  btnLbl: { fontSize: 13, fontWeight: '700', color: '#e2e8f0' },
});
