const { promisify } = require('util');
const path = require('path');

const DS = {
  DRAFT: 'Draft',
  READY: 'Ready For Delivery',
  DRIVER_ASSIGNED: 'Driver Assigned',
  CONFIRMED: 'Confirmed',
  OPENED: 'Opened by Driver',
  PICKED_UP: 'Picked Up (Loaded)',
  OUT: 'Out For Delivery',
  POD: 'POD Uploaded',
  CLOSED: 'Closed',
};

function trimStr(v) {
  return String(v ?? '').trim();
}

function normalizePhone(s) {
  return String(s || '').replace(/[^\d]/g, '');
}

function normalizePackageType(t) {
  const v = String(t || '').trim().toLowerCase();
  if (v === 'pallet') return 'Pallet';
  if (v === 'box') return 'Box';
  if (v === 'ignore') return 'Ignore';
  return '';
}

function normalizeTransportType(t) {
  const v = String(t || '').trim().toLowerCase();
  if (v === 'gapp' || v === 'own') return 'GAPP';
  if (v === 'rental') return 'Rental';
  if (v === 'courier') return 'Courier';
  if (v === 'self collection' || v === 'selfcollection') return 'Self Collection';
  return '';
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dnIsLocked(dn) {
  if (!dn) return true;
  if (Number(dn.is_closed) === 1) return true;
  const ds = String(dn.delivery_status || '').toLowerCase();
  if (ds === 'closed') return true;
  return false;
}

/** Delivery To filled: address snapshot present */
function hasDeliveryToFilled(dn) {
  return Boolean(trimStr(dn?.delivery_address));
}

function packageValidated(dn) {
  const pkg = normalizePackageType(dn?.package_type);
  if (!pkg) return false;
  if (!trimStr(dn?.invoice_number)) return false;
  if ((pkg === 'Pallet' || pkg === 'Box') && !(asNumber(pkg === 'Pallet' ? dn.pallet_qty : dn.box_qty) > 0)) {
    return false;
  }
  return true;
}

function gappTransportReady(dn) {
  if (normalizeTransportType(dn?.transportation_type) !== 'GAPP') return true;
  const hasDriver = Boolean(trimStr(dn?.driver_name)) || dn?.driver_id;
  const hasPhone = Boolean(trimStr(dn?.driver_mobile));
  const hasVehicle = Boolean(trimStr(dn?.vehicle));
  return hasDriver && hasPhone && hasVehicle;
}

async function findUserIdByMobile(db, rawMobile) {
  const dbAll = promisify(db.all.bind(db));
  const want = normalizePhone(rawMobile);
  if (!want || want.length < 6) return null;
  const rows = await dbAll(
    `SELECT id, mobile_number FROM users WHERE mobile_number IS NOT NULL AND TRIM(mobile_number) != ''`
  );
  for (const r of rows || []) {
    if (normalizePhone(r.mobile_number) === want) return r.id;
  }
  return null;
}

function canConfirmGapp(dn) {
  if (normalizeTransportType(dn?.transportation_type) !== 'GAPP') return false;
  if (!hasDeliveryToFilled(dn)) return false;
  if (!packageValidated(dn)) return false;
  if (!gappTransportReady(dn)) return false;
  return true;
}

function relPathForUpload(absPath) {
  if (!absPath) return null;
  const base = path.join(__dirname, '..', 'uploads');
  if (String(absPath).startsWith(base)) {
    return path.relative(path.join(__dirname, '..'), absPath).split(path.sep).join('/');
  }
  return String(absPath);
}

module.exports = {
  DS,
  trimStr,
  normalizePhone,
  normalizePackageType,
  normalizeTransportType,
  asNumber,
  dnIsLocked,
  hasDeliveryToFilled,
  packageValidated,
  gappTransportReady,
  canConfirmGapp,
  findUserIdByMobile,
  relPathForUpload,
};
