import { View, StyleSheet } from 'react-native';
import type { ScanRoi } from '../utils/scanRoi';

type Props = {
  roi: ScanRoi;
};

/** Dimmed overlay with a rectangular scanning window (normalized ROI). */
export function ScanRoiOverlay({ roi }: Props) {
  const topP = roi.top * 100;
  const leftP = roi.left * 100;
  const wP = roi.width * 100;
  const hP = roi.height * 100;
  const bottomStart = (roi.top + roi.height) * 100;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.mask, { height: `${topP}%` }]} />
      <View style={[styles.mask, { top: `${bottomStart}%`, bottom: 0, left: 0, right: 0 }]} />
      <View style={[styles.mask, { top: `${topP}%`, height: `${hP}%`, left: 0, width: `${leftP}%` }]} />
      <View
        style={[styles.mask, { top: `${topP}%`, height: `${hP}%`, left: `${leftP + wP}%`, right: 0 }]}
      />

      <View style={[styles.frame, { left: `${leftP}%`, top: `${topP}%`, width: `${wP}%`, height: `${hP}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  mask: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.52)',
    left: 0,
    right: 0,
    top: 0,
  },
  frame: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#38bdf8',
    borderRadius: 6,
    backgroundColor: 'transparent',
  },
});
