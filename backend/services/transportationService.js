const path = require('path');

const CARRIER_TYPES = ['GAPP', 'Rental', 'Courier', 'Self Collection'];
const VEHICLE_TYPES = ['Pickup', 'Dyna', 'Trailer', 'Lorry', 'Boom Truck', 'Car'];
const ATTACHMENT_TYPES = [
  'Iqama',
  'Driving License',
  'Insurance',
  'Fahas / Vehicle Inspection',
  'Vehicle Document / Istimara',
  'Gate Pass',
  'Other',
];

function normCarrierType(t) {
  const v = String(t || '').trim();
  const low = v.toLowerCase();
  if (low === 'own' || low === 'gapp') return 'GAPP';
  if (low === 'rental') return 'Rental';
  if (low === 'courier') return 'Courier';
  if (low === 'self collection' || low === 'selfcollection') return 'Self Collection';
  return v;
}

function parseLocalDate(str) {
  if (!str || !String(str).trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function startOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** @returns {number|null} days from today to date (negative = expired) */
function daysFromToday(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  const t0 = startOfToday().getTime();
  const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((t1 - t0) / 86400000);
}

const EXPIRY_FIELDS = [
  { col: 'iqama_expiry', expired: 'Iqama expired', soon: 'Iqama expiring soon' },
  { col: 'license_expiry', expired: 'Driving license expired', soon: 'Driving license expiring soon' },
  { col: 'vehicle_document_expiry', expired: 'Vehicle document expired', soon: 'Vehicle document expiring soon' },
  { col: 'insurance_expiry', expired: 'Insurance expired', soon: 'Insurance expiring soon' },
  { col: 'fahas_expiry', expired: 'Fahas expired', soon: 'Fahas expiring soon' },
];

function computeAutoWarning(row) {
  const parts = [];
  for (const { col, expired, soon } of EXPIRY_FIELDS) {
    const val = row[col];
    if (!val || !String(val).trim()) continue;
    const days = daysFromToday(val);
    if (days === null) continue;
    if (days < 0) parts.push(expired);
    else if (days <= 30) parts.push(soon);
  }
  return parts.join('; ');
}

function legacyVehicleDisplay(d) {
  const a = String(d.vehicle_type || '').trim();
  const b = String(d.vehicle_number || '').trim();
  if (a && b) return `${a} / ${b}`;
  return a || b || null;
}

function toLegacyCarrier(r) {
  return {
    id: r.id,
    carrier_name: r.carrier_name,
    carrier_type: r.carrier_type,
    is_active: String(r.status || 'Active') === 'Active' ? 1 : 0,
  };
}

function toLegacyDriver(d) {
  return {
    id: d.id,
    carrier_id: d.carrier_id,
    driver_name: d.driver_name,
    phone_number: d.driver_phone,
    vehicle: legacyVehicleDisplay(d),
    vehicle_type: d.vehicle_type || null,
    vehicle_number: d.vehicle_number || null,
    is_active: String(d.status || 'Active') === 'Active' ? 1 : 0,
  };
}

function parseVehicleToFields(vehicleStr) {
  const s = String(vehicleStr || '').trim();
  if (!s) return { vehicle_type: null, vehicle_number: null };
  const idx = s.indexOf(' / ');
  if (idx > 0) {
    return {
      vehicle_type: s.slice(0, idx).trim() || null,
      vehicle_number: s.slice(idx + 3).trim() || null,
    };
  }
  return { vehicle_type: null, vehicle_number: s || null };
}

function sanitizeFilePart(name) {
  return String(name || '')
    .trim()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'driver';
}

function driverPdfBasename(driver) {
  const n = sanitizeFilePart(driver.driver_name);
  const v = sanitizeFilePart(driver.vehicle_number);
  return v ? `driver_${n}_${v}.pdf` : `driver_${n}.pdf`;
}

function attachmentDiskPath(rel) {
  return path.join(__dirname, '..', rel.replace(/^\//, ''));
}

module.exports = {
  CARRIER_TYPES,
  VEHICLE_TYPES,
  ATTACHMENT_TYPES,
  normCarrierType,
  computeAutoWarning,
  legacyVehicleDisplay,
  toLegacyCarrier,
  toLegacyDriver,
  parseVehicleToFields,
  daysFromToday,
  driverPdfBasename,
  attachmentDiskPath,
};
