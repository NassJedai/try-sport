import { base64UrlToUtf8, utf8ToBase64Url } from './base64.js';

/**
 * Cursor pagination everywhere a list can grow without bound.
 * Offset pagination drifts when rows are inserted mid-scroll, which shows the user
 * duplicates in the discovery feed — exactly what makes a feed feel broken.
 */

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorPayload {
  /** Primary sort value: an ISO timestamp, a distance in metres, or a score. */
  readonly sortValue: string | number;
  /** Tie-breaker; always a unique id so the ordering is total and stable. */
  readonly id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return utf8ToBase64Url(JSON.stringify([payload.sortValue, payload.id]));
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(base64UrlToUtf8(cursor));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortValue, id] = parsed as [unknown, unknown];
    if (typeof id !== 'string') return null;
    if (typeof sortValue !== 'string' && typeof sortValue !== 'number') return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

/**
 * Fetch `limit + 1` rows, then call this: the extra row reveals whether another
 * page exists without paying for a second COUNT query.
 */
export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): CursorPage<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last ? encodeCursor(toCursor(last)) : null,
  };
}
