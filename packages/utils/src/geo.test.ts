import { describe, expect, it } from 'vitest';
import {
  boundingBoxAround,
  distanceInMeters,
  formatDistance,
  GeoError,
  assertValidCoordinates,
} from './geo.js';

const GRAND_PLACE = { latitude: 50.8467, longitude: 4.3525 };
const IXELLES_FLAGEY = { latitude: 50.8276, longitude: 4.3722 };

describe('geo', () => {
  it('measures a known Brussels distance within tolerance', () => {
    // Grand-Place -> Flagey is roughly 2.4 km as the crow flies.
    const meters = distanceInMeters(GRAND_PLACE, IXELLES_FLAGEY);
    expect(meters).toBeGreaterThan(2200);
    expect(meters).toBeLessThan(2700);
  });

  it('is symmetric and zero for identical points', () => {
    expect(distanceInMeters(GRAND_PLACE, GRAND_PLACE)).toBe(0);
    expect(distanceInMeters(GRAND_PLACE, IXELLES_FLAGEY)).toBeCloseTo(
      distanceInMeters(IXELLES_FLAGEY, GRAND_PLACE),
      6,
    );
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => assertValidCoordinates({ latitude: 91, longitude: 0 })).toThrow(GeoError);
    expect(() => assertValidCoordinates({ latitude: 0, longitude: 181 })).toThrow(GeoError);
  });

  it('builds a bounding box that actually contains the radius', () => {
    const box = boundingBoxAround(GRAND_PLACE, 5000);
    expect(box.minLatitude).toBeLessThan(GRAND_PLACE.latitude);
    expect(box.maxLatitude).toBeGreaterThan(GRAND_PLACE.latitude);

    const northEdge = { latitude: box.maxLatitude, longitude: GRAND_PLACE.longitude };
    expect(distanceInMeters(GRAND_PLACE, northEdge)).toBeGreaterThanOrEqual(4990);
  });

  it('formats distance the way the offer card shows it', () => {
    expect(formatDistance(240)).toBe('250 m');
    expect(formatDistance(80)).toBe('80 m');
    expect(formatDistance(1200)).toBe('1,2 km');
    expect(formatDistance(15400)).toBe('15 km');
  });
});
