import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  intervalsOverlap,
  timeZoneOffsetMinutes,
  utcToZonedParts,
  zonedDayKey,
  zonedTimeToUtc,
} from './time.js';

describe('time', () => {
  it('reports Brussels offsets across the DST boundary', () => {
    // CET (+1) in January, CEST (+2) in July.
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Brussels')).toBe(60);
    expect(timeZoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Europe/Brussels')).toBe(120);
  });

  it('converts a venue wall-clock time to the correct UTC instant on both sides of DST', () => {
    const winter = zonedTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 19, minute: 0 },
      'Europe/Brussels',
    );
    expect(winter.toISOString()).toBe('2026-01-15T18:00:00.000Z');

    const summer = zonedTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 19, minute: 0 },
      'Europe/Brussels',
    );
    expect(summer.toISOString()).toBe('2026-07-15T17:00:00.000Z');
  });

  it('round-trips wall-clock time through UTC', () => {
    const parts = { year: 2026, month: 3, day: 29, hour: 14, minute: 30 };
    const instant = zonedTimeToUtc(parts, 'Europe/Brussels');
    expect(utcToZonedParts(instant, 'Europe/Brussels')).toEqual(parts);
  });

  it('groups slots by the venue-local calendar day, not the UTC day', () => {
    // 23:30 UTC is already the next day in Brussels.
    expect(zonedDayKey(new Date('2026-07-15T23:30:00Z'), 'Europe/Brussels')).toBe('2026-07-16');
    expect(zonedDayKey(new Date('2026-07-15T23:30:00Z'), 'UTC')).toBe('2026-07-15');
  });

  it('detects overlapping intervals but treats touching intervals as free', () => {
    const a = { startAt: new Date('2026-07-15T10:00:00Z'), endAt: new Date('2026-07-15T11:00:00Z') };
    const touching = {
      startAt: new Date('2026-07-15T11:00:00Z'),
      endAt: new Date('2026-07-15T12:00:00Z'),
    };
    const overlapping = {
      startAt: new Date('2026-07-15T10:30:00Z'),
      endAt: new Date('2026-07-15T11:30:00Z'),
    };
    expect(intervalsOverlap(a, touching)).toBe(false);
    expect(intervalsOverlap(a, overlapping)).toBe(true);
  });

  it('gives tests a deterministic clock', () => {
    const clock = new FixedClock(new Date('2026-07-15T10:00:00Z'));
    clock.advance(90 * 60_000);
    expect(clock.now().toISOString()).toBe('2026-07-15T11:30:00.000Z');
  });
});
