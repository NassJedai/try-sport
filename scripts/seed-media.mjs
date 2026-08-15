/**
 * Donne un visuel à chaque offre et chaque lieu du catalogue qui n'en a pas.
 *
 * Une marketplace sans images ne ressemble à rien — et le circuit média
 * (upload, stockage, service) existe, seul le CONTENU manquait. Ce script
 * fabrique une image de marque par discipline (dégradé aux couleurs de la
 * catégorie, pas une photo volée à une banque d'images) et l'attache via les
 * mêmes tables que l'upload des gérants. Idempotent : une entité qui a déjà
 * une image n'est jamais touchée — on ne remplace pas ce qu'un gérant a envoyé.
 *
 * Usage :  node scripts/seed-media.mjs   (depuis la racine du repo)
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from '../packages/database/dist/index.js';
import { sql } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://try@127.0.0.1:5433/try_dev';
// Le même répertoire que l'API en dev : elle tourne avec apps/api pour cwd.
const MEDIA_DIR = join(import.meta.dirname, '..', 'apps', 'api', '.media');

/** Deux couleurs par discipline — assez distinctes pour reconnaître un rail. */
const PALETTES = {
  fitness: [[233, 84, 32], [120, 20, 60]],
  ems: [[255, 196, 0], [180, 60, 0]],
  pilates: [[151, 71, 255], [40, 20, 90]],
  yoga: [[52, 168, 83], [10, 60, 40]],
  boxing: [[220, 38, 38], [30, 10, 10]],
  crossfit: [[55, 65, 81], [17, 24, 39]],
  cycling: [[14, 165, 233], [15, 23, 42]],
  padel: [[132, 204, 22], [20, 60, 20]],
  tennis: [[250, 204, 21], [21, 94, 117]],
  escalade: [[168, 85, 247], [30, 27, 75]],
  danse: [[236, 72, 153], [76, 5, 46]],
  natation: [[6, 182, 212], [8, 47, 73]],
  'arts-martiaux': [[100, 116, 139], [15, 23, 42]],
  'personal-training': [[249, 115, 22], [67, 20, 7]],
  recovery: [[45, 212, 191], [19, 78, 74]],
  running: [[251, 146, 60], [124, 45, 18]],
};
const FALLBACK = [[16, 122, 87], [11, 15, 20]];

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Un dégradé diagonal avec une trame discrète — l'aléa par pixel évite les
 * bandes de quantification qui font « image générée par un stagiaire ».
 */
function makeImage(from, to, seed) {
  const W = 800;
  const H = 600;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB

  let noise = seed >>> 0 || 1;
  const rand = () => {
    // xorshift32 : rapide, déterministe par graine — même offre, même image.
    noise ^= noise << 13;
    noise ^= noise >>> 17;
    noise ^= noise << 5;
    return ((noise >>> 0) % 1000) / 1000;
  };

  const rows = [];
  for (let y = 0; y < H; y += 1) {
    const row = Buffer.alloc(1 + W * 3);
    row[0] = 0;
    for (let x = 0; x < W; x += 1) {
      const t = (x / W + y / H) / 2;
      const dither = (rand() - 0.5) * 14;
      for (let c = 0; c < 3; c += 1) {
        const value = from[c] + (to[c] - from[c]) * t + dither;
        row[1 + x * 3 + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
    rows.push(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function seedFromId(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

const { db, close } = createDatabase({ url: DATABASE_URL });
await mkdir(MEDIA_DIR, { recursive: true });

const offers = await db.execute(sql`
  SELECT o.id, c.slug AS category
  FROM offers o
  JOIN categories c ON c.id = o.category_id
  WHERE o.status = 'ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM offer_images WHERE offer_id = o.id)
`);

const venues = await db.execute(sql`
  SELECT v.id,
    (SELECT c.slug FROM offers o JOIN categories c ON c.id = o.category_id
     WHERE o.venue_id = v.id ORDER BY o.created_at LIMIT 1) AS category
  FROM venues v
  WHERE v.status = 'ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM venue_images WHERE venue_id = v.id)
`);

let written = 0;
for (const [kind, rows] of [
  ['offer', offers],
  ['venue', venues],
]) {
  for (const row of rows) {
    const [from, to] = PALETTES[row.category] ?? FALLBACK;
    const png = makeImage(from, to, seedFromId(row.id));
    const key = `${kind}-${row.id}-seed.png`;
    await writeFile(join(MEDIA_DIR, key), png);

    if (kind === 'offer') {
      await db.execute(sql`
        INSERT INTO offer_images (offer_id, storage_key, width, height, sort_order)
        VALUES (${row.id}, ${key}, 800, 600, 0)
      `);
    } else {
      await db.execute(sql`
        INSERT INTO venue_images (venue_id, storage_key, width, height, sort_order)
        VALUES (${row.id}, ${key}, 800, 600, 0)
      `);
    }
    written += 1;
  }
}

console.log(`${written} visuels générés (${offers.length} offres, ${venues.length} lieux)`);
await close();
