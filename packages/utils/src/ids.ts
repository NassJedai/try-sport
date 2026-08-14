import { bytesToBase64Url } from './base64.js';
import { randomStringFromAlphabet, secureRandomBytes } from './random.js';

/**
 * Human-facing codes deliberately exclude I, O, 0 and 1 so a staff member reading
 * a code off a phone screen at a noisy gym desk cannot transcribe it wrongly.
 */
const HUMAN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Short check-in code shown to the user, e.g. "K7QP-3XN9". ~40 bits of entropy. */
export function generateCheckInCode(): string {
  const raw = randomStringFromAlphabet(HUMAN_ALPHABET, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeCheckInCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** URL-safe high-entropy token (QR payloads, magic links, webhook replay keys). */
export function generateSecureToken(byteLength = 32): string {
  return bytesToBase64Url(secureRandomBytes(byteLength));
}

/** Numeric one-time password for email login. */
export function generateNumericOtp(length = 6): string {
  return randomStringFromAlphabet('0123456789', length);
}

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
