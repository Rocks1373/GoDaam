import * as FileSystem from 'expo-file-system/legacy';

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
  description: string;
  rack_location: string;
  qty_in: number;
  source_type: string;
  reference_no: string;
  remarks: string;
};

export function resetSessionFile() {
  sessionUri = null;
}

export async function getSessionUri() {
  return sessionUri;
}

export async function appendRackScanRow(row: RackScanRow) {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error('documentDirectory unavailable');

  if (!sessionUri) {
    sessionUri = base + newSessionFilename();
    await FileSystem.writeAsStringAsync(sessionUri, '', { encoding: FileSystem.EncodingType.UTF8 });
  }

  const line = [
    row.transaction_date,
    row.part_number,
    row.sap_part_number,
    row.description,
    row.rack_location,
    row.qty_in,
    row.source_type,
    row.reference_no,
    row.remarks,
  ]
    .map((c) => String(c).replace(/,/g, ' '))
    .join(',');

  let prev = '';
  try {
    prev = await FileSystem.readAsStringAsync(sessionUri);
  } catch {
    prev = '';
  }
  await FileSystem.writeAsStringAsync(sessionUri, `${prev}${line}\n`, { encoding: FileSystem.EncodingType.UTF8 });
  return sessionUri;
}

export async function readSessionFile(): Promise<string> {
  if (!sessionUri) return '';
  const info = await FileSystem.getInfoAsync(sessionUri);
  if (!info.exists) return '';
  return FileSystem.readAsStringAsync(sessionUri);
}

export async function clearLocalScanFile() {
  if (sessionUri) {
    try {
      await FileSystem.deleteAsync(sessionUri, { idempotent: true });
    } catch {
      // ignore
    }
  }
  sessionUri = null;
}
