import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@try/config';
import { CryptoService, stableStringify } from './crypto.service.js';

const service = new CryptoService({
  CHECKIN_TOKEN_SECRET: 'c'.repeat(32),
} as AppConfig);

describe('CryptoService', () => {
  it('hashes deterministically and irreversibly', () => {
    const hash = service.hashToken('123456');
    expect(hash).toBe(service.hashToken('123456'));
    expect(hash).not.toBe(service.hashToken('123457'));
    expect(hash).not.toContain('123456');
  });

  it('compares equal and unequal values correctly', () => {
    expect(service.safeEqual('abc', 'abc')).toBe(true);
    expect(service.safeEqual('abc', 'abd')).toBe(false);
    // Different lengths must not throw the way a raw timingSafeEqual would.
    expect(service.safeEqual('abc', 'abcdef')).toBe(false);
    expect(service.safeEqual('', '')).toBe(true);
  });

  describe('check-in signatures', () => {
    it('accepts a signature it produced', () => {
      const payload = 'reservation-1.K7QP-3XN9';
      expect(service.verifyCheckInPayload(payload, service.signCheckInPayload(payload))).toBe(true);
    });

    it('rejects a signature for a different reservation', () => {
      // The whole point of signing: a valid QR for booking A must not admit booking B.
      const signature = service.signCheckInPayload('reservation-1.K7QP-3XN9');
      expect(service.verifyCheckInPayload('reservation-2.K7QP-3XN9', signature)).toBe(false);
    });

    it('rejects an unsigned or garbage signature', () => {
      expect(service.verifyCheckInPayload('reservation-1.CODE', '')).toBe(false);
      expect(service.verifyCheckInPayload('reservation-1.CODE', 'forged')).toBe(false);
    });

    it('produces different signatures under different secrets', () => {
      const other = new CryptoService({ CHECKIN_TOKEN_SECRET: 'd'.repeat(32) } as AppConfig);
      const payload = 'reservation-1.CODE';
      expect(service.signCheckInPayload(payload)).not.toBe(other.signCheckInPayload(payload));
    });
  });

  describe('request fingerprinting for idempotency', () => {
    it('ignores key order so an identical retry is recognised', () => {
      // Clients do not guarantee JSON key order; treating a reorder as a
      // different request would reject a legitimate retry.
      expect(service.fingerprint({ a: 1, b: 2 })).toBe(service.fingerprint({ b: 2, a: 1 }));
    });

    it('changes when a value changes', () => {
      expect(service.fingerprint({ slotId: 'a' })).not.toBe(service.fingerprint({ slotId: 'b' }));
    });

    it('distinguishes nested differences', () => {
      expect(service.fingerprint({ a: { b: 1 } })).not.toBe(service.fingerprint({ a: { b: 2 } }));
    });

    it('treats an absent key and an undefined value as the same request', () => {
      expect(service.fingerprint({ a: 1, b: undefined })).toBe(service.fingerprint({ a: 1 }));
    });

    it('does not confuse an array with an object', () => {
      expect(stableStringify([1, 2])).not.toBe(stableStringify({ 0: 1, 1: 2 }));
    });

    it('handles null and primitives', () => {
      expect(stableStringify(null)).toBe('null');
      expect(stableStringify(5)).toBe('5');
      expect(stableStringify('x')).toBe('"x"');
    });
  });
});
