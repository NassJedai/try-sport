import { describe, expect, it } from 'vitest';
import { base64UrlToUtf8, bytesToBase64Url, utf8ToBase64Url } from './base64.js';
import { generateCheckInCode, generateNumericOtp, normalizeCheckInCode, slugify } from './ids.js';
import { buildCursorPage, decodeCursor, encodeCursor } from './pagination.js';

describe('base64url', () => {
  it('round-trips unicode without relying on Buffer or btoa', () => {
    const samples = ['', 'a', 'ab', 'abc', 'Pilates Reformer — Ixelles', '🥊 boxe', 'é'.repeat(50)];
    for (const sample of samples) {
      expect(base64UrlToUtf8(utf8ToBase64Url(sample))).toBe(sample);
    }
  });

  it('produces url-safe output only', () => {
    const encoded = bytesToBase64Url(Uint8Array.from([251, 255, 254, 0, 1, 2]));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('ids', () => {
  it('generates check-in codes without ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCheckInCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('normalises what staff type in', () => {
    expect(normalizeCheckInCode(' k7qp-3xn9 ')).toBe('K7QP3XN9');
  });

  it('generates OTPs of the requested length, zero-padding included', () => {
    const codes = Array.from({ length: 100 }, () => generateNumericOtp(6));
    expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
  });

  it('slugifies accented venue names', () => {
    expect(slugify('Studio Móve — Ixelles!')).toBe('studio-move-ixelles');
  });
});

describe('cursor pagination', () => {
  it('round-trips a cursor payload', () => {
    const cursor = encodeCursor({ sortValue: '2026-07-15T10:00:00.000Z', id: 'abc' });
    expect(decodeCursor(cursor)).toEqual({ sortValue: '2026-07-15T10:00:00.000Z', id: 'abc' });
  });

  it('returns null for a malformed cursor instead of throwing', () => {
    expect(decodeCursor('not-a-cursor!!')).toBeNull();
    expect(decodeCursor(utf8ToBase64Url('{"a":1}'))).toBeNull();
  });

  it('uses the extra row to signal a next page', () => {
    const rows = [1, 2, 3, 4].map((n) => ({ id: String(n), score: n }));
    const page = buildCursorPage(rows, 3, (row) => ({ sortValue: row.score, id: row.id }));
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor as string)).toEqual({ sortValue: 3, id: '3' });
  });

  it('reports no next page when the result fits', () => {
    const rows = [{ id: '1', score: 1 }];
    expect(buildCursorPage(rows, 3, (row) => ({ sortValue: row.score, id: row.id })).nextCursor)
      .toBeNull();
  });
});
