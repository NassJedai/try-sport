import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { createDatabase } from '../client.js';

/**
 * Donne un visuel à chaque offre et chaque lieu du catalogue qui n'en a pas.
 *
 * Une marketplace sans images ne ressemble à rien — et le circuit média (upload,
 * stockage, service) existe, seul le CONTENU manquait. Ce module fabrique une
 * image de marque par discipline (dégradé aux couleurs de la catégorie, pas une
 * photo volée à une banque d'images) et l'attache via les mêmes tables que
 * l'upload des gérants.
 *
 * Idempotent au sens fort : une entité qui a déjà une image n'est jamais
 * touchée — on ne remplace pas ce qu'un gérant a envoyé. C'est ce qui permet à
 * `seed.ts` d'appeler `attachMissingMedia` sans arguments après avoir recréé
 * tout le catalogue (TRUNCATE + réinsertion, donc toujours sans image au
 * démarrage) *et* de laisser ce module tourner seul, plus tard, contre une base
 * qui a évolué depuis (nouvelle offre publiée, gérant qui n'a pas encore
 * uploadé de photo) sans jamais écraser une image existante.
 */

/** Deux couleurs par discipline — assez distinctes pour reconnaître un rail. */
const PALETTES: Record<string, [[number, number, number], [number, number, number]]> = {
  fitness: [
    [233, 84, 32],
    [120, 20, 60],
  ],
  ems: [
    [255, 196, 0],
    [180, 60, 0],
  ],
  pilates: [
    [151, 71, 255],
    [40, 20, 90],
  ],
  yoga: [
    [52, 168, 83],
    [10, 60, 40],
  ],
  boxing: [
    [220, 38, 38],
    [30, 10, 10],
  ],
  crossfit: [
    [55, 65, 81],
    [17, 24, 39],
  ],
  cycling: [
    [14, 165, 233],
    [15, 23, 42],
  ],
  padel: [
    [132, 204, 22],
    [20, 60, 20],
  ],
  tennis: [
    [250, 204, 21],
    [21, 94, 117],
  ],
  escalade: [
    [168, 85, 247],
    [30, 27, 75],
  ],
  danse: [
    [236, 72, 153],
    [76, 5, 46],
  ],
  natation: [
    [6, 182, 212],
    [8, 47, 73],
  ],
  'arts-martiaux': [
    [100, 116, 139],
    [15, 23, 42],
  ],
  'personal-training': [
    [249, 115, 22],
    [67, 20, 7],
  ],
  recovery: [
    [45, 212, 191],
    [19, 78, 74],
  ],
  running: [
    [251, 146, 60],
    [124, 45, 18],
  ],
};
const FALLBACK: [[number, number, number], [number, number, number]] = [
  [16, 122, 87],
  [11, 15, 20],
];

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
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
function makeImage(from: [number, number, number], to: [number, number, number], seed: number): Buffer {
  const W = 800;
  const H = 600;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB

  let noise = seed >>> 0 || 1;
  const rand = (): number => {
    // xorshift32 : rapide, déterministe par graine — même offre, même image.
    noise ^= noise << 13;
    noise ^= noise >>> 17;
    noise ^= noise << 5;
    return ((noise >>> 0) % 1000) / 1000;
  };

  const rows: Buffer[] = [];
  for (let y = 0; y < H; y += 1) {
    const row = Buffer.alloc(1 + W * 3);
    row[0] = 0;
    for (let x = 0; x < W; x += 1) {
      const t = (x / W + y / H) / 2;
      const dither = (rand() - 0.5) * 14;
      for (let c = 0; c < 3; c += 1) {
        const value = (from[c] ?? 0) + ((to[c] ?? 0) - (from[c] ?? 0)) * t + dither;
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

function seedFromId(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** Le même répertoire que l'API en dev : elle tourne avec apps/api pour cwd. */
export function defaultMediaDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/scripts -> src -> database -> packages -> racine du dépôt.
  return join(here, '..', '..', '..', '..', 'apps', 'api', '.media');
}

interface MissingImageRow {
  id: string;
  category: string | null;
}

/**
 * Génère et attache un visuel à chaque offre et lieu actif qui n'en a pas
 * encore. Ne touche jamais une ligne `offer_images`/`venue_images` existante.
 */
export async function attachMissingMedia(
  db: Executor,
  mediaDir: string,
): Promise<{ offers: number; venues: number }> {
  await mkdir(mediaDir, { recursive: true });

  const offers = (await db.execute(sql`
    SELECT o.id, c.slug AS category
    FROM offers o
    JOIN categories c ON c.id = o.category_id
    WHERE o.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM offer_images WHERE offer_id = o.id)
  `)) as unknown as MissingImageRow[];

  const venues = (await db.execute(sql`
    SELECT v.id,
      (SELECT c.slug FROM offers o JOIN categories c ON c.id = o.category_id
       WHERE o.venue_id = v.id ORDER BY o.created_at LIMIT 1) AS category
    FROM venues v
    WHERE v.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM venue_images WHERE venue_id = v.id)
  `)) as unknown as MissingImageRow[];

  for (const [kind, rows] of [
    ['offer', offers],
    ['venue', venues],
  ] as const) {
    for (const row of rows) {
      const [from, to] = (row.category ? PALETTES[row.category] : undefined) ?? FALLBACK;
      const png = makeImage(from, to, seedFromId(row.id));
      const key = `${kind}-${row.id}-seed.png`;
      await writeFile(join(mediaDir, key), png);

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
    }
  }

  return { offers: offers.length, venues: venues.length };
}

/**
 * Point d'entrée autonome — `pnpm --filter @try/database seed:media`. Utile
 * pour compléter un catalogue déjà peuplé (nouvelle offre publiée depuis,
 * gérant qui n'a pas encore uploadé) sans repasser par un `pnpm db:seed` complet,
 * qui recréerait tout le catalogue. `seed.ts` n'utilise pas cette voie : il
 * appelle `attachMissingMedia` directement, sur la connexion déjà ouverte.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const { db, close } = createDatabase({ url, maxConnections: 1 });
  try {
    const mediaDir = process.env.MEDIA_DIR ? join(process.cwd(), process.env.MEDIA_DIR) : defaultMediaDir();
    const { offers, venues } = await attachMissingMedia(db, mediaDir);
    console.log(`${offers + venues} visuels générés (${offers} offres, ${venues} lieux)`);
  } finally {
    await close();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('seed-media failed:', error);
    process.exit(1);
  });
}
