import qrcode from 'qrcode-generator';

/**
 * QR encoding for check-in tokens.
 *
 * Uses `qrcode-generator` — pure JavaScript, no Node built-ins, so it runs under
 * Hermes without polyfills. Hand-rolling Reed–Solomon error correction would be
 * a needless risk for something a scanner at a gym desk has to read first time.
 */

/**
 * Error correction level M (~15% recovery).
 *
 * L would produce a slightly denser-looking code but tolerates almost no damage;
 * Q and H inflate the module count for a payload this size, making each module
 * smaller on screen and *harder* to scan. M is the right trade for a screen held
 * under a scanner.
 */
const ERROR_CORRECTION = 'M' as const;

/** Type 0 lets the library pick the smallest version that fits the payload. */
const AUTO_VERSION = 0;

export type QrMatrix = boolean[][];

export function encodeQr(value: string): QrMatrix {
  const qr = qrcode(AUTO_VERSION, ERROR_CORRECTION);
  qr.addData(value);
  qr.make();

  const size = qr.getModuleCount();
  const matrix: QrMatrix = [];

  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = [];
    for (let column = 0; column < size; column += 1) {
      cells.push(qr.isDark(row, column));
    }
    matrix.push(cells);
  }

  return matrix;
}
