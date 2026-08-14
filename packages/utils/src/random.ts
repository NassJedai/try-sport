/**
 * Single entry point for cryptographic randomness so that every security-relevant
 * token in TRY (QR payloads, OTPs, check-in codes) comes from a CSPRNG and never
 * from Math.random(). Fails loudly rather than silently degrading.
 */
interface WebCryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

function webCrypto(): WebCryptoLike {
  const candidate = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!candidate || typeof candidate.getRandomValues !== 'function') {
    throw new Error(
      'No cryptographically secure random source available (crypto.getRandomValues missing).',
    );
  }
  return candidate;
}

export function secureRandomBytes(length: number): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(length));
}

/**
 * Uniform sampling over an arbitrary alphabet. `byte % alphabet.length` would bias
 * towards early characters whenever the alphabet does not divide 256, so values
 * above the largest whole multiple are rejected and re-drawn.
 */
export function randomStringFromAlphabet(alphabet: string, length: number): string {
  if (alphabet.length === 0 || alphabet.length > 256) {
    throw new Error(`Alphabet size must be between 1 and 256, received ${alphabet.length}`);
  }
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let result = '';
  while (result.length < length) {
    for (const byte of secureRandomBytes((length - result.length) * 2)) {
      if (byte >= limit) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}
