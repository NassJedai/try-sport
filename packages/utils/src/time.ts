/**
 * Rule enforced across TRY: timestamps are stored in UTC and rendered in the
 * venue's (or user's) IANA timezone. Nothing in the domain ever handles a naive
 * local time, because "19:00" means two different instants across a DST change.
 */

export type IanaTimeZone = string;

export const DEFAULT_TIME_ZONE: IanaTimeZone = 'Europe/Brussels';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date(Date.now());
  }
}

/** Deterministic clock for tests and for replaying time-sensitive domain rules. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = next;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TimeInterval {
  readonly startAt: Date;
  readonly endAt: Date;
}

export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

export function durationMinutes(interval: TimeInterval): number {
  return Math.round((interval.endAt.getTime() - interval.startAt.getTime()) / MINUTE_MS);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

/**
 * Offset of a timezone at a given instant, in minutes east of UTC.
 * Derived from Intl so DST is handled by the platform's tz database rather
 * than by a hardcoded table that goes stale.
 */
export function timeZoneOffsetMinutes(instant: Date, timeZone: IanaTimeZone): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  // `hour` can come back as 24 for midnight in some ICU versions.
  const hour = lookup('hour') % 24;
  const asUtc = Date.UTC(
    lookup('year'),
    lookup('month') - 1,
    lookup('day'),
    hour,
    lookup('minute'),
    lookup('second'),
  );
  return Math.round((asUtc - instant.getTime()) / MINUTE_MS);
}

/**
 * Converts a wall-clock time in `timeZone` to the UTC instant it denotes.
 * Used when a business schedules "Monday 19:00 at this venue".
 */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: IanaTimeZone,
): Date {
  const naiveUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  // Two passes: the first offset may belong to the wrong side of a DST boundary.
  const firstGuess = new Date(naiveUtc - timeZoneOffsetMinutes(new Date(naiveUtc), timeZone) * MINUTE_MS);
  const correctedOffset = timeZoneOffsetMinutes(firstGuess, timeZone);
  return new Date(naiveUtc - correctedOffset * MINUTE_MS);
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function utcToZonedParts(instant: Date, timeZone: IanaTimeZone): ZonedDateParts {
  const offset = timeZoneOffsetMinutes(instant, timeZone);
  const shifted = new Date(instant.getTime() + offset * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Calendar day key ("2026-03-14") in the given timezone — used to group slots by day. */
export function zonedDayKey(instant: Date, timeZone: IanaTimeZone): string {
  const { year, month, day } = utcToZonedParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatTimeInZone(
  instant: Date,
  timeZone: IanaTimeZone,
  locale = 'fr-BE',
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

export function formatDateInZone(
  instant: Date,
  timeZone: IanaTimeZone,
  locale = 'fr-BE',
  options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' },
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(instant);
}
