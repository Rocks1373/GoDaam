import * as FileSystem from 'expo-file-system/legacy';

let sessionUri: string | null = null;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function newFilename() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `putaway_${ymd}_${hm}.txt`;
}

/** CSV-style local putaway log for offline / share / audit */
export async function appendPutawayLine(row: {
  transaction_date: string;
  part_number: string;
  rack_location: string;
  qty: number;
  remarks: string;
  inbound_batch_id: number;
  inbound_item_id: number;
  synced?: string;
}) {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error('documentDirectory unavailable');

  if (!sessionUri) {
    sessionUri = base + newFilename();
    await FileSystem.writeAsStringAsync(
      sessionUri,
      'transaction_date,part_number,rack_location,qty,remarks,inbound_batch_id,inbound_item_id,synced\n',
      { encoding: FileSystem.EncodingType.UTF8 }
    );
  }

  const line = [
    row.transaction_date,
    row.part_number,
    row.rack_location,
    row.qty,
    String(row.remarks || '').replace(/,/g, ' '),
    row.inbound_batch_id,
    row.inbound_item_id,
    row.synced || '',
  ].join(',');

  let prev = '';
  try {
    prev = await FileSystem.readAsStringAsync(sessionUri);
  } catch {
    prev = '';
  }
  await FileSystem.writeAsStringAsync(sessionUri, `${prev}${line}\n`, { encoding: FileSystem.EncodingType.UTF8 });
  return sessionUri;
}

export async function getPutawaySessionUri() {
  return sessionUri;
}

export async function readPutawayFile(): Promise<string> {
  if (!sessionUri) return '';
  const info = await FileSystem.getInfoAsync(sessionUri);
  if (!info.exists) return '';
  return FileSystem.readAsStringAsync(sessionUri);
}

export async function clearPutawaySessionFile() {
  if (sessionUri) {
    try {
      await FileSystem.deleteAsync(sessionUri, { idempotent: true });
    } catch {
      // ignore
    }
  }
  sessionUri = null;
}

export function resetPutawaySessionPath() {
  sessionUri = null;
}
