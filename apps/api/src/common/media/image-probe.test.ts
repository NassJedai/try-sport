import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { probeImage } from './image-probe.js';

/**
 * Les fixtures sont de vraies images minimales, construites octet par octet —
 * pas des fichiers binaires commités qu'on ne peut pas relire. Si un test casse,
 * la fixture se lit comme une spécification du format.
 */

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Un PNG valide et décodable de `width`×`height`, gris uni. */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 0; // niveaux de gris

  const scanlines = Buffer.alloc(height * (1 + width), 0x80);
  for (let row = 0; row < height; row += 1) scanlines[row * (1 + width)] = 0; // filtre « none »

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Un squelette JPEG : SOI, un segment APP0 à sauter, puis SOF0. */
function makeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0)]);
  const sof0 = Buffer.alloc(19);
  sof0.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

/** Un en-tête WebP VP8L (sans perte), dimensions encodées sur 14 bits chacune. */
function makeWebpLossless(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const header = Buffer.alloc(30);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(22, 4);
  header.write('WEBP', 8, 'ascii');
  header.write('VP8L', 12, 'ascii');
  header.writeUInt32LE(14, 16);
  header[20] = 0x2f;
  header.writeUInt32LE(bits, 21);
  return header;
}

describe('probeImage', () => {
  it('lit les dimensions d\x27un PNG', () => {
    expect(probeImage(makePng(640, 480))).toMatchObject({
      format: 'png',
      width: 640,
      height: 480,
    });
  });

  it('trouve le SOF d\x27un JPEG derrière les segments préliminaires', () => {
    expect(probeImage(makeJpeg(1920, 1080))).toMatchObject({
      format: 'jpeg',
      width: 1920,
      height: 1080,
    });
  });

  it('décode l\x27en-tête compact d\x27un WebP sans perte', () => {
    expect(probeImage(makeWebpLossless(800, 600))).toMatchObject({
      format: 'webp',
      width: 800,
      height: 600,
    });
  });

  it('rejette ce qui n\x27est pas une image, quel que soit le Content-Type déclaré', () => {
    // Le cas d'attaque réel : un HTML poussé comme « image », qui servirait du
    // script depuis notre domaine.
    expect(probeImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(probeImage(Buffer.from('%PDF-1.4 ...'))).toBeNull();
    expect(probeImage(Buffer.alloc(0))).toBeNull();
  });

  it('rejette un JPEG tronqué sans boucler', () => {
    expect(probeImage(makeJpeg(100, 100).subarray(0, 6))).toBeNull();
  });

  it('rejette des dimensions absurdes', () => {
    expect(probeImage(makePng(50_000, 10))).toBeNull();
  });
});
