/** Normalized scan region of interest (0–1) relative to camera preview. */
export type ScanRoi = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export const DEFAULT_SCAN_ROI: ScanRoi = {
  left: 0.08,
  top: 0.34,
  width: 0.84,
  height: 0.24,
};

export function clampRoi(r: ScanRoi): ScanRoi {
  let { left, top, width, height } = r;
  width = Math.min(Math.max(width, 0.12), 1);
  height = Math.min(Math.max(height, 0.1), 1);
  left = Math.min(Math.max(left, 0), 1 - width);
  top = Math.min(Math.max(top, 0), 1 - height);
  return { left, top, width, height };
}

export function moveRoiVertical(roi: ScanRoi, delta: number): ScanRoi {
  return clampRoi({ ...roi, top: roi.top + delta });
}

/** Scale around center; factor > 1 grows. */
export function scaleRoi(roi: ScanRoi, factor: number): ScanRoi {
  const cx = roi.left + roi.width / 2;
  const cy = roi.top + roi.height / 2;
  let width = roi.width * factor;
  let height = roi.height * factor;
  width = Math.min(width, 1);
  height = Math.min(height, 1);
  let left = cx - width / 2;
  let top = cy - height / 2;
  return clampRoi({ left, top, width, height });
}

export function adjustRoiWidth(roi: ScanRoi, delta: number): ScanRoi {
  const cx = roi.left + roi.width / 2;
  let width = roi.width + delta;
  width = Math.min(Math.max(width, 0.15), 0.98);
  let left = cx - width / 2;
  return clampRoi({ ...roi, left, width });
}

export function adjustRoiHeight(roi: ScanRoi, delta: number): ScanRoi {
  const cy = roi.top + roi.height / 2;
  let height = roi.height + delta;
  height = Math.min(Math.max(height, 0.12), 0.98);
  let top = cy - height / 2;
  return clampRoi({ ...roi, top, height });
}

/** Barcode accepted only if its center lies inside ROI (preview pixels). */
export function isBarcodeCenterInRoi(
  bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } | undefined,
  previewW: number,
  previewH: number,
  roi: ScanRoi
): boolean {
  if (!bounds || previewW <= 0 || previewH <= 0) return true;
  const bw = bounds.size?.width ?? 0;
  const bh = bounds.size?.height ?? 0;
  if (bw <= 0 || bh <= 0) return true;
  const ox = bounds.origin?.x ?? 0;
  const oy = bounds.origin?.y ?? 0;
  const cx = ox + bw / 2;
  const cy = oy + bh / 2;
  const x0 = roi.left * previewW;
  const y0 = roi.top * previewH;
  const x1 = (roi.left + roi.width) * previewW;
  const y1 = (roi.top + roi.height) * previewH;
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}
