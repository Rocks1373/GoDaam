function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Try to parse {lat,lng} from:
 * - "lat,lng"
 * - Google Maps URLs containing "@lat,lng"
 * - "destination=lat,lng" or "q=lat,lng" or "query=lat,lng"
 */
function parseLatLng(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const direct = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (direct) {
    const lat = toNum(direct[1]);
    const lng = toNum(direct[2]);
    if (lat == null || lng == null) return null;
    return { latitude: lat, longitude: lng };
  }

  const at = raw.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = toNum(at[1]);
    const lng = toNum(at[2]);
    if (lat == null || lng == null) return null;
    return { latitude: lat, longitude: lng };
  }

  const qp = raw.match(/[?&](?:destination|q|query)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i);
  if (qp) {
    const lat = toNum(qp[1]);
    const lng = toNum(qp[2]);
    if (lat == null || lng == null) return null;
    return { latitude: lat, longitude: lng };
  }

  return null;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLat = lat2 - lat1;
  const dLng = toRad(b.longitude - a.longitude);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest-neighbor ordering starting from origin.
 * Stops without lat/lng must be filtered out before calling.
 */
function nearestNeighborOrder(origin, stops) {
  const remaining = [...stops];
  const out = [];
  let cur = { latitude: origin.latitude, longitude: origin.longitude };
  while (remaining.length) {
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const d = haversineKm(cur, s);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    out.push(next);
    cur = { latitude: next.latitude, longitude: next.longitude };
  }
  return out;
}

module.exports = { parseLatLng, haversineKm, nearestNeighborOrder };

