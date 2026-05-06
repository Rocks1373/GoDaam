export type LatLng = { latitude: number; longitude: number };

function fmt(n: number): string {
  // keep links short but stable
  return Number(n).toFixed(6).replace(/\.?0+$/, '');
}

export function googleMapsSingleDestinationUrl(dest: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${fmt(dest.latitude)},${fmt(dest.longitude)}&travelmode=driving`;
}

/**
 * Multi-stop Google Maps directions (no API key, no billing).
 * Google supports up to 9 waypoints in a single URL.
 */
export function googleMapsMultiStopUrls(args: {
  origin: LatLng;
  stopsInOrder: LatLng[]; // ordered delivery stops (at least 2)
}): string[] {
  const { origin, stopsInOrder } = args;
  if (stopsInOrder.length === 0) return [];
  if (stopsInOrder.length === 1) return [googleMapsSingleDestinationUrl(stopsInOrder[0])];

  const maxWaypoints = 9;
  const maxStopsPerUrl = maxWaypoints + 1; // destination is also a stop, not a waypoint

  const urls: string[] = [];

  let idx = 0;
  let partOrigin = origin;
  while (idx < stopsInOrder.length) {
    const chunk = stopsInOrder.slice(idx, idx + maxStopsPerUrl);
    if (chunk.length === 1) {
      urls.push(googleMapsSingleDestinationUrl(chunk[0]));
      break;
    }
    const destination = chunk[chunk.length - 1];
    const waypoints = chunk.slice(0, chunk.length - 1);

    const wp = waypoints
      .map((p) => `${fmt(p.latitude)},${fmt(p.longitude)}`)
      .join('|');

    const url =
      `https://www.google.com/maps/dir/?api=1` +
      `&origin=${fmt(partOrigin.latitude)},${fmt(partOrigin.longitude)}` +
      `&destination=${fmt(destination.latitude)},${fmt(destination.longitude)}` +
      (wp ? `&waypoints=${encodeURIComponent(wp)}` : '') +
      `&travelmode=driving`;
    urls.push(url);

    // next part starts where this ended
    partOrigin = destination;
    idx += chunk.length;
  }

  return urls;
}

