import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { bytesToBase64Url } from '@try/utils';
import type { AppConfig } from '@try/config';
import { CONFIG } from './config.module.js';

/**
 * All hashing and token signing in one place.
 *
 * Comparisons use `timingSafeEqual` because comparing a submitted OTP or QR token
 * with `===` leaks its prefix through response timing.
 */
@Injectable()
export class CryptoService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /**
   * SHA-256 for high-entropy secrets (OTPs, refresh tokens, QR payloads).
   * Deliberately *not* a password hash: these are 128+ bit random values with a
   * short lifetime, so a slow KDF would only add latency to every request without
   * changing what an attacker can do.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    // timingSafeEqual throws on length mismatch, which itself leaks length; hash
    // both sides first so the comparison is always over equal-length buffers.
    const digestA = createHash('sha256').update(bufferA).digest();
    const digestB = createHash('sha256').update(bufferB).digest();
    return timingSafeEqual(digestA, digestB);
  }

  /** Stable fingerprint of a request body, used to detect idempotency-key misuse. */
  fingerprint(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  sign(payload: string, secret: string): string {
    return bytesToBase64Url(new Uint8Array(createHmac('sha256', secret).update(payload).digest()));
  }

  signCheckInPayload(payload: string): string {
    return this.sign(payload, this.config.CHECKIN_TOKEN_SECRET);
  }

  verifyCheckInPayload(payload: string, signature: string): boolean {
    return this.safeEqual(this.signCheckInPayload(payload), signature);
  }
}

/**
 * Key order must not change the fingerprint, or a client that serialises its JSON
 * differently would be told its identical retry is a conflicting request.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(',')}}`;
}
