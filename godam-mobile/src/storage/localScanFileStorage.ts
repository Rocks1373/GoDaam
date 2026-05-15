import * as FileSystem from 'expo-file-system/legacy';

const SESSION_JSON = 'rack_scan_session.json';
/** Human-readable log — always kept in sync with session; only removed when user clears all. */
const SCAN_LOG_TXT = 'rack_scan_log.txt';
/** Legacy export name (still deleted on clear for old installs). */
const EXPORT_TXT = 'rack_scan_export.txt';

/** Legacy in-memory pointer (still set when writing export for sharing) */
let sessionUri: string | null = null;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function newSessionFilename() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `rack_scan_${ymd}_${hm}.txt`;
}

export type RackScanRow = {
  transaction_date: string;
  part_number: string;
  sap_part_number: string;
  rack_location: string;
  qty_in: number;
  source_type: string;
  reference_no: string;
  remarks: string;
};

export type RackScanRowPersisted = RackScanRow & {
  id: string;
  savedAt: number;
};

type SessionFile = {
  version: 1;
  rows: RackScanRowPersisted[];
};

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function rowToCsvLine(row: RackScanRow): string {
  return [
    row.transaction_date,
    row.part_number,
    row.sap_part_number,
    row.rack_location,
    row.qty_in,
    row.source_type,
    row.reference_no,
    row.remarks,
  ]
    .map((c) => String(c).replace(/,/g, ' '))
    .join(',');
}

function parseTxtLine(line: string): RackScanRow | null {
  const t = line.trim();
  if (!t) return null;
  const parts = t.split(',');
  if (parts.length < 8) return null;
  const qty = Number(parts[4]);
  if (!Number.isFinite(qty)) return null;
  return {
    transaction_date: parts[0],
    part_number: parts[1],
    sap_part_number: parts[2],
    rack_location: parts[3],
    qty_in: qty,
    source_type: parts[5],
    reference_no: parts[6],
    remarks: parts[7] ?? '-',
  };
}

async function migrateFromScanLogTxt(base: string): Promise<RackScanRowPersisted[]> {
  try {
    const path = base + SCAN_LOG_TXT;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(path);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const baseTs = Date.now() - lines.length * 1000;
    const rows: RackScanRowPersisted[] = [];
    lines.forEach((line, i) => {
      const parsed = parseTxtLine(line);
      if (!parsed) return;
      rows.push({
        ...parsed,
        id: `txt-${i}-${baseTs}`,
        savedAt: baseTs + i * 1000,
      });
    });
    return rows;
  } catch {
    return [];
  }
}

async function migrateFromLegacyTxt(base: string): Promise<RackScanRowPersisted[]> {
  try {
    const entries = await FileSystem.readDirectoryAsync(base);
    const txts = entries.filter(
      (f) => f.startsWith('rack_scan_') && f.endsWith('.txt') && f !== SCAN_LOG_TXT
    );
    if (!txts.length) return [];

    let bestPath = '';
    let bestTime = 0;
    for (const name of txts) {
      const info = await FileSystem.getInfoAsync(base + name);
      const mod = info.modificationTime ?? 0;
      if (mod >= bestTime) {
        bestTime = mod;
        bestPath = base + name;
      }
    }
    if (!bestPath) return [];

    const raw = await FileSystem.readAsStringAsync(bestPath);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const baseTs = Date.now() - lines.length * 1000;
    const rows: RackScanRowPersisted[] = [];
    lines.forEach((line, i) => {
      const parsed = parseTxtLine(line);
      if (!parsed) return;
      rows.push({
        ...parsed,
        id: `m-${i}-${baseTs}`,
        savedAt: baseTs + i * 1000,
      });
    });
    return rows;
  } catch {
    return [];
  }
}

async function readSessionJson(base: string): Promise<SessionFile | null> {
  const path = base + SESSION_JSON;
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    const data = JSON.parse(raw) as SessionFile;
    if (data?.version !== 1 || !Array.isArray(data.rows)) return { version: 1, rows: [] };
    return data;
  } catch {
    return { version: 1, rows: [] };
  }
}

async function writeSessionJson(base: string, rows: RackScanRowPersisted[]) {
  const path = base + SESSION_JSON;
  const payload: SessionFile = { version: 1, rows };
  await FileSystem.writeAsStringAsync(path, JSON.stringify(payload), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/** Full rewrite of the on-device TXT log (append-only from user perspective until Clear all). */
async function writeTextLogFromRows(base: string, rows: RackScanRowPersisted[]) {
  const path = base + SCAN_LOG_TXT;
  const body =
    rows.length === 0
      ? ''
      : [...rows]
          .sort((a, b) => a.savedAt - b.savedAt)
          .map((r) => rowToCsvLine(r))
          .join('\n') + '\n';
  await FileSystem.writeAsStringAsync(path, body, { encoding: FileSystem.EncodingType.UTF8 });
}

/** Load all saved rack rows (each row has savedAt for ordering). */
export async function loadSessionRows(): Promise<RackScanRowPersisted[]> {
  const base = FileSystem.documentDirectory;
  if (!base) return [];

  const jsonPath = base + SESSION_JSON;
  const jsonInfo = await FileSystem.getInfoAsync(jsonPath);

  if (!jsonInfo.exists) {
    let migrated = await migrateFromScanLogTxt(base);
    if (!migrated.length) migrated = await migrateFromLegacyTxt(base);
    if (migrated.length) {
      await writeSessionJson(base, migrated);
      await writeTextLogFromRows(base, migrated);
    }
    return migrated;
  }

  const session = await readSessionJson(base);
  return session.rows;
}

/** Rows sorted newest first (for UI). */
export async function loadSessionRowsNewestFirst(): Promise<RackScanRowPersisted[]> {
  const rows = await loadSessionRows();
  return [...rows].sort((a, b) => b.savedAt - a.savedAt);
}

export function resetSessionFile() {
  sessionUri = null;
}

export async function getSessionUri() {
  const base = FileSystem.documentDirectory;
  if (!base) return null;
  const rows = await loadSessionRows();
  if (!rows.length) return null;
  await writeTextLogFromRows(base, rows);
  const logPath = base + SCAN_LOG_TXT;
  sessionUri = logPath;
  return logPath;
}

/** Filename of the persistent scan log (under app document directory). */
export function getScanLogTxtBasename() {
  return SCAN_LOG_TXT;
}

export async function appendRackScanRow(row: RackScanRow): Promise<{ uri: string | null; id: string }> {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error('documentDirectory unavailable');

  const rows = await loadSessionRows();
  const id = newId();
  const savedAt = Date.now();
  const persisted: RackScanRowPersisted = { ...row, id, savedAt };
  rows.push(persisted);
  await writeSessionJson(base, rows);
  await writeTextLogFromRows(base, rows);

  const uri = base + SCAN_LOG_TXT;
  sessionUri = uri;
  return { uri, id };
}

export async function updateRackScanRow(
  id: string,
  patch: Partial<
    Pick<RackScanRow, 'part_number' | 'sap_part_number' | 'rack_location' | 'qty_in' | 'remarks' | 'transaction_date'>
  >
): Promise<void> {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error('documentDirectory unavailable');

  const rows = await loadSessionRows();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error('Row not found');

  if (patch.part_number !== undefined) rows[idx].part_number = patch.part_number.trim();
  if (patch.sap_part_number !== undefined) rows[idx].sap_part_number = patch.sap_part_number.trim();
  if (patch.rack_location !== undefined) rows[idx].rack_location = patch.rack_location.trim();
  if (patch.qty_in !== undefined) rows[idx].qty_in = patch.qty_in;
  if (patch.remarks !== undefined) rows[idx].remarks = patch.remarks.trim() || '-';
  if (patch.transaction_date !== undefined) rows[idx].transaction_date = patch.transaction_date.trim();

  await writeSessionJson(base, rows);
  await writeTextLogFromRows(base, rows);
}

export async function readSessionFile(): Promise<string> {
  const rows = await loadSessionRows();
  if (!rows.length) return '';
  return (
    [...rows]
      .sort((a, b) => a.savedAt - b.savedAt)
      .map((r) => rowToCsvLine(r))
      .join('\n') + '\n'
  );
}

export async function clearLocalScanFile() {
  const base = FileSystem.documentDirectory;
  if (base) {
    try {
      await FileSystem.deleteAsync(base + SESSION_JSON, { idempotent: true });
    } catch {
      // ignore
    }
    try {
      await FileSystem.deleteAsync(base + EXPORT_TXT, { idempotent: true });
    } catch {
      // ignore
    }
    try {
      await FileSystem.deleteAsync(base + SCAN_LOG_TXT, { idempotent: true });
    } catch {
      // ignore
    }
    try {
      const entries = await FileSystem.readDirectoryAsync(base);
      const legacyTxts = entries.filter(
        (f) => f.startsWith('rack_scan_') && f.endsWith('.txt') && f !== SCAN_LOG_TXT
      );
      for (const name of legacyTxts) {
        await FileSystem.deleteAsync(base + name, { idempotent: true }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }
  sessionUri = null;
}
