export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface BoundingBox {
  readonly minLatitude: number;
  readonly minLongitude: number;
  readonly maxLatitude: number;
  readonly maxLongitude: number;
}

export class GeoError extends Error {}

const EARTH_RADIUS_METERS = 6_371_008.8;

export function assertValidCoordinates(value: Coordinates): void {
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) {
    throw new GeoError(`Latitude out of range: ${value.latitude}`);
  }
  if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    throw new GeoError(`Longitude out of range: ${value.longitude}`);
  }
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance. The API returns authoritative distances from PostGIS
 * (`ST_Distance` on geography); this exists for client-side estimates while a
 * cached list is on screen and for tests, so results stay consistent.
 */
export function distanceInMeters(from: Coordinates, to: Coordinates): number {
  assertValidCoordinates(from);
  assertValidCoordinates(to);

  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Square bounding box around a point — used to pre-filter map viewport queries. */
export function boundingBoxAround(center: Coordinates, radiusMeters: number): BoundingBox {
  assertValidCoordinates(center);
  if (radiusMeters <= 0) throw new GeoError(`Radius must be positive, received ${radiusMeters}`);

  const latDelta = (radiusMeters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const cosLat = Math.cos(toRadians(center.latitude));
  // Near the poles longitude degrees collapse; clamp to avoid a division blow-up.
  const lonDelta =
    Math.abs(cosLat) < 1e-9 ? 180 : latDelta / Math.max(Math.abs(cosLat), 1e-9);

  return {
    minLatitude: Math.max(-90, center.latitude - latDelta),
    maxLatitude: Math.min(90, center.latitude + latDelta),
    minLongitude: Math.max(-180, center.longitude - lonDelta),
    maxLongitude: Math.min(180, center.longitude + lonDelta),
  };
}

export function boundingBoxCenter(box: BoundingBox): Coordinates {
  return {
    latitude: (box.minLatitude + box.maxLatitude) / 2,
    longitude: (box.minLongitude + box.maxLongitude) / 2,
  };
}

/** Diagonal of the viewport, used to derive a radius for "search this area". */
export function boundingBoxRadiusMeters(box: BoundingBox): number {
  const diagonal = distanceInMeters(
    { latitude: box.minLatitude, longitude: box.minLongitude },
    { latitude: box.maxLatitude, longitude: box.maxLongitude },
  );
  return diagonal / 2;
}

export interface FormatDistanceOptions {
  locale?: string;
}

/** "850 m" below a kilometre, "1,2 km" above it — never "0.85 km". */
export function formatDistance(meters: number, options: FormatDistanceOptions = {}): string {
  const { locale = 'fr-BE' } = options;
  if (!Number.isFinite(meters) || meters < 0) return '';

  if (meters < 1000) {
    const rounded = meters < 100 ? Math.round(meters / 10) * 10 : Math.round(meters / 50) * 50;
    return `${new Intl.NumberFormat(locale).format(rounded)} m`;
  }
  const km = meters / 1000;
  const digits = km < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(km)} km`;
}
