/**
 * Dependency-free base64url. `@try/utils` is imported by the Expo app as well as
 * the API, and neither `Buffer` (Node) nor `btoa` (DOM) is guaranteed in Hermes,
 * so encoding is implemented directly rather than assuming a host global.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE_LOOKUP: Record<string, number> = {};
for (let index = 0; index < ALPHABET.length; index += 1) {
  DECODE_LOOKUP[ALPHABET[index] as string] = index;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    output += ALPHABET[b0 >> 2];
    output += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    output += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    output += ALPHABET[b2 & 0x3f];
  }
  return output;
}

export function base64UrlToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '');
  const byteLength = Math.floor((clean.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);

  let bitBuffer = 0;
  let bitCount = 0;
  let offset = 0;

  for (const char of clean) {
    const value = DECODE_LOOKUP[char];
    if (value === undefined) throw new Error(`Invalid base64url character: "${char}"`);
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[offset] = (bitBuffer >> bitCount) & 0xff;
      offset += 1;
    }
  }
  return bytes;
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(encodeUtf8(text));
}

export function base64UrlToUtf8(input: string): string {
  return decodeUtf8(base64UrlToBytes(input));
}

function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const codePoint = text.codePointAt(i) as number;
    if (codePoint > 0xffff) i += 1;

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] as number;
    let codePoint: number;
    let extraBytes: number;

    if (byte < 0x80) {
      codePoint = byte;
      extraBytes = 0;
    } else if ((byte & 0xe0) === 0xc0) {
      codePoint = byte & 0x1f;
      extraBytes = 1;
    } else if ((byte & 0xf0) === 0xe0) {
      codePoint = byte & 0x0f;
      extraBytes = 2;
    } else {
      codePoint = byte & 0x07;
      extraBytes = 3;
    }

    for (let i = 1; i <= extraBytes; i += 1) {
      codePoint = (codePoint << 6) | ((bytes[index + i] as number) & 0x3f);
    }
    result += String.fromCodePoint(codePoint);
    index += extraBytes + 1;
  }
  return result;
}
