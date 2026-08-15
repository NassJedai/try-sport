import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import type { Logger } from '@try/logger';
import { randomStringFromAlphabet } from '@try/utils';
import { DATABASE } from '../../common/database.module.js';
import { CONFIG } from '../../common/config.module.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { hasBusinessRole, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { MAX_IMAGE_BYTES, probeImage } from '../../common/media/image-probe.js';

/**
 * Les photos des salles et des offres.
 *
 * Le stockage est le disque local, derrière ce service et rien d'autre : le jour
 * du passage à un stockage objet (S3, R2), c'est CE fichier qui change, pas les
 * contrôleurs, pas le schéma, pas les apps. `STORAGE_PUBLIC_BASE_URL` découple
 * déjà les URLs publiques du lieu de stockage réel.
 *
 * Les clés sont plates (`venue-<id>-<aléa>.jpg`) : pas de sous-répertoires, donc
 * pas de traversée de chemin possible par construction, et une route de service
 * à un seul paramètre.
 */
const MAX_IMAGES_PER_ENTITY = 10;

@Injectable()
export class MediaService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Résolu une fois ; `resolve` rend le chemin absolu quel que soit le cwd. */
  private mediaDir(): string {
    return resolve(this.config.MEDIA_DIR);
  }

  async uploadVenueImage(input: {
    actor: AuthenticatedUser;
    venueId: string;
    body: Buffer;
  }): Promise<{ id: string; url: string }> {
    const [venue] = await this.db
      .select({ id: schema.venues.id, businessId: schema.venues.businessId })
      .from(schema.venues)
      .where(eq(schema.venues.id, input.venueId))
      .limit(1);

    if (!venue) throw ApiException.notFound('venue', input.venueId);
    this.assertManager(input.actor, venue.businessId);

    const { key, width, height } = await this.persistFile('venue', venue.id, input.body);

    const [row] = await this.db
      .insert(schema.venueImages)
      .values({
        venueId: venue.id,
        storageKey: key,
        width,
        height,
        sortOrder: sql`COALESCE((SELECT MAX(sort_order) + 1 FROM venue_images WHERE venue_id = ${venue.id}), 0)`,
      })
      .returning({ id: schema.venueImages.id });

    await this.enforceLimit('venue_images', 'venue_id', venue.id, key);

    return { id: row!.id, url: this.publicUrl(key) };
  }

  async uploadOfferImage(input: {
    actor: AuthenticatedUser;
    offerId: string;
    body: Buffer;
  }): Promise<{ id: string; url: string }> {
    const [offer] = await this.db
      .select({ id: schema.offers.id, businessId: schema.offers.businessId })
      .from(schema.offers)
      .where(eq(schema.offers.id, input.offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', input.offerId);
    this.assertManager(input.actor, offer.businessId);

    const { key, width, height } = await this.persistFile('offer', offer.id, input.body);

    const [row] = await this.db
      .insert(schema.offerImages)
      .values({
        offerId: offer.id,
        storageKey: key,
        width,
        height,
        sortOrder: sql`COALESCE((SELECT MAX(sort_order) + 1 FROM offer_images WHERE offer_id = ${offer.id}), 0)`,
      })
      .returning({ id: schema.offerImages.id });

    await this.enforceLimit('offer_images', 'offer_id', offer.id, key);

    return { id: row!.id, url: this.publicUrl(key) };
  }

  async deleteVenueImage(input: {
    actor: AuthenticatedUser;
    venueId: string;
    imageId: string;
  }): Promise<void> {
    const [venue] = await this.db
      .select({ businessId: schema.venues.businessId })
      .from(schema.venues)
      .where(eq(schema.venues.id, input.venueId))
      .limit(1);

    if (!venue) throw ApiException.notFound('venue', input.venueId);
    this.assertManager(input.actor, venue.businessId);

    // Le WHERE porte aussi sur venue_id : l'id d'une image d'une autre salle ne
    // doit pas suffire à la supprimer.
    const [deleted] = await this.db
      .delete(schema.venueImages)
      .where(
        and(eq(schema.venueImages.id, input.imageId), eq(schema.venueImages.venueId, input.venueId)),
      )
      .returning({ storageKey: schema.venueImages.storageKey });

    if (deleted) await this.removeFile(deleted.storageKey);
  }

  async deleteOfferImage(input: {
    actor: AuthenticatedUser;
    offerId: string;
    imageId: string;
  }): Promise<void> {
    const [offer] = await this.db
      .select({ businessId: schema.offers.businessId })
      .from(schema.offers)
      .where(eq(schema.offers.id, input.offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', input.offerId);
    this.assertManager(input.actor, offer.businessId);

    const [deleted] = await this.db
      .delete(schema.offerImages)
      .where(
        and(eq(schema.offerImages.id, input.imageId), eq(schema.offerImages.offerId, input.offerId)),
      )
      .returning({ storageKey: schema.offerImages.storageKey });

    if (deleted) await this.removeFile(deleted.storageKey);
  }

  /** Les photos d'une salle, pour l'écran de gestion du gérant. */
  async listVenueImages(input: {
    actor: AuthenticatedUser;
    venueId: string;
  }): Promise<{ items: { id: string; url: string; width: number; height: number }[] }> {
    const [venue] = await this.db
      .select({ businessId: schema.venues.businessId })
      .from(schema.venues)
      .where(eq(schema.venues.id, input.venueId))
      .limit(1);

    if (!venue) throw ApiException.notFound('venue', input.venueId);
    if (!hasBusinessRole(input.actor, venue.businessId, 'STAFF')) {
      throw ApiException.forbidden('requires STAFF');
    }

    const rows = await this.db
      .select()
      .from(schema.venueImages)
      .where(eq(schema.venueImages.venueId, input.venueId))
      .orderBy(schema.venueImages.sortOrder);

    return {
      items: rows.map((row) => ({
        id: row.id,
        url: this.publicUrl(row.storageKey),
        width: row.width,
        height: row.height,
      })),
    };
  }

  async listOfferImages(input: {
    actor: AuthenticatedUser;
    offerId: string;
  }): Promise<{ items: { id: string; url: string; width: number; height: number }[] }> {
    const [offer] = await this.db
      .select({ businessId: schema.offers.businessId })
      .from(schema.offers)
      .where(eq(schema.offers.id, input.offerId))
      .limit(1);

    if (!offer) throw ApiException.notFound('offer', input.offerId);
    if (!hasBusinessRole(input.actor, offer.businessId, 'STAFF')) {
      throw ApiException.forbidden('requires STAFF');
    }

    const rows = await this.db
      .select()
      .from(schema.offerImages)
      .where(eq(schema.offerImages.offerId, input.offerId))
      .orderBy(schema.offerImages.sortOrder);

    return {
      items: rows.map((row) => ({
        id: row.id,
        url: this.publicUrl(row.storageKey),
        width: row.width,
        height: row.height,
      })),
    };
  }

  /** Lecture d'un fichier pour la route publique /media. */
  async readFile(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    // Liste blanche stricte : une clé est plate, minuscule, avec une extension
    // connue. Tout le reste — « .. », « / », « %2e » — est refusé avant de
    // toucher au système de fichiers.
    if (!/^[a-z0-9-]+\.(jpg|png|webp)$/.test(key)) return null;

    try {
      const body = await readFile(join(this.mediaDir(), key));
      const contentType =
        key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return { body, contentType };
    } catch {
      return null;
    }
  }

  private assertManager(actor: AuthenticatedUser, businessId: string): void {
    // MANAGER, pas STAFF : la vitrine publique d'un établissement n'est pas du
    // ressort de la personne à l'accueil.
    if (!hasBusinessRole(actor, businessId, 'MANAGER')) {
      throw ApiException.forbidden('requires MANAGER');
    }
  }

  private async persistFile(
    kind: 'venue' | 'offer',
    entityId: string,
    body: Buffer,
  ): Promise<{ key: string; width: number; height: number }> {
    if (body.length === 0) {
      throw new ApiException('VALIDATION_FAILED', 'empty upload');
    }
    if (body.length > MAX_IMAGE_BYTES) {
      throw new ApiException('VALIDATION_FAILED', 'image exceeds the 8 MB limit');
    }

    // Le contenu fait foi, jamais le Content-Type déclaré par le client.
    const probed = probeImage(body);
    if (!probed) {
      throw new ApiException(
        'VALIDATION_FAILED',
        'unsupported image format (JPEG, PNG or WebP required)',
      );
    }

    const key = `${kind}-${entityId}-${randomStringFromAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10)}.${probed.extension}`;

    await mkdir(this.mediaDir(), { recursive: true });
    // Le fichier d'abord, la ligne ensuite : une ligne sans fichier est une
    // image cassée à l'écran ; un fichier sans ligne n'est qu'un orphelin sur
    // disque, invisible et nettoyable.
    await writeFile(join(this.mediaDir(), key), body);

    return { key, width: probed.width, height: probed.height };
  }

  /**
   * Plafonne le nombre d'images par entité, quel que soit le nombre de requêtes
   * simultanées : on garde les N plus anciennes par sort_order, l'excédent —
   * dont, le cas échéant, celle qu'on vient d'insérer — est supprimé.
   */
  private async enforceLimit(
    table: 'venue_images' | 'offer_images',
    column: 'venue_id' | 'offer_id',
    entityId: string,
    justInserted: string,
  ): Promise<void> {
    const excess = await this.db.execute(sql`
      DELETE FROM ${sql.raw(table)}
      WHERE ${sql.raw(column)} = ${entityId}
        AND id NOT IN (
          SELECT id FROM ${sql.raw(table)}
          WHERE ${sql.raw(column)} = ${entityId}
          ORDER BY sort_order ASC, created_at ASC
          LIMIT ${MAX_IMAGES_PER_ENTITY}
        )
      RETURNING storage_key
    `);

    for (const row of excess as unknown as { storage_key: string }[]) {
      if (row.storage_key === justInserted) {
        // La onzième image est refusée, pas silencieusement avalée.
        await this.removeFile(row.storage_key);
        throw new ApiException(
          'VALIDATION_FAILED',
          `an entity holds at most ${MAX_IMAGES_PER_ENTITY} images`,
        );
      }
      await this.removeFile(row.storage_key);
    }
  }

  private publicUrl(key: string): string {
    return `${this.config.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
  }

  private async removeFile(key: string): Promise<void> {
    try {
      await rm(join(this.mediaDir(), key));
    } catch (error) {
      // Un fichier déjà absent n'est pas une erreur ; tout le reste se journalise.
      this.logger.warn({ err: error, key }, 'failed to remove media file');
    }
  }
}
