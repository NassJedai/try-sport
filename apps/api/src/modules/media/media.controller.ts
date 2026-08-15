import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { Public } from '../../common/auth/auth.guard.js';
import { MediaService } from './media.service.js';

/**
 * Upload et gestion des photos.
 *
 * Le corps de la requête est l'image elle-même, en binaire brut — pas de
 * multipart. Un fichier par requête, le Content-Type déclare le format (et le
 * serveur re-vérifie par les octets magiques de toute façon) : c'est un `fetch`
 * d'une ligne côté client, et zéro dépendance de parsing côté serveur.
 */
@ApiTags('media')
@Controller({ version: '1' })
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('venues/:venueId/images')
  @ApiOperation({ summary: 'Upload a venue photo (raw image body)' })
  uploadVenueImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; url: string }> {
    return this.media.uploadVenueImage({
      actor: user,
      venueId,
      body: request.body as Buffer,
    });
  }

  @Get('venues/:venueId/images')
  @ApiOperation({ summary: 'List venue photos with their public URLs' })
  listVenueImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
  ): Promise<{ items: { id: string; url: string }[] }> {
    return this.media.listVenueImages({ actor: user, venueId });
  }

  @Delete('venues/:venueId/images/:imageId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a venue photo' })
  async deleteVenueImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId', ParseUUIDPipe) venueId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<void> {
    await this.media.deleteVenueImage({ actor: user, venueId, imageId });
  }

  @Post('offers/:offerId/images')
  @ApiOperation({ summary: 'Upload an offer photo (raw image body)' })
  uploadOfferImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; url: string }> {
    return this.media.uploadOfferImage({
      actor: user,
      offerId,
      body: request.body as Buffer,
    });
  }

  @Get('offers/:offerId/images')
  @ApiOperation({ summary: 'List offer photos with their public URLs' })
  listOfferImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<{ items: { id: string; url: string }[] }> {
    return this.media.listOfferImages({ actor: user, offerId });
  }

  @Delete('offers/:offerId/images/:imageId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an offer photo' })
  async deleteOfferImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<void> {
    await this.media.deleteOfferImage({ actor: user, offerId, imageId });
  }
}

/**
 * Service des fichiers en local.
 *
 * En production, `STORAGE_PUBLIC_BASE_URL` pointera vers un CDN et cette route
 * ne servira plus rien — elle reste inoffensive : elle ne sait lire que des clés
 * plates validées par liste blanche, sous le répertoire média et nulle part
 * ailleurs.
 */
@ApiTags('media')
@Controller({ path: 'media', version: VERSION_NEUTRAL })
export class MediaFileController {
  constructor(private readonly media: MediaService) {}

  @Public()
  @Get(':key')
  async serve(@Param('key') key: string, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.media.readFile(key);

    if (!file) {
      await reply.status(404).send({ code: 'NOT_FOUND' });
      return;
    }

    await reply
      .header('Content-Type', file.contentType)
      // Les clés contiennent un aléa : un fichier donné ne change jamais de
      // contenu, il est remplacé par une autre clé. Le cache peut être long.
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      // Helmet pose `same-origin` globalement — correct pour du JSON, mais une
      // photo est faite pour être INTÉGRÉE depuis les apps web et mobile, qui
      // sont d'autres origins. Sans cette dérogation, le navigateur affiche une
      // image cassée alors que le serveur répond 200 : trouvé à l'écran, pas
      // dans les tests, qui ne voient jamais les en-têtes d'un autre point de
      // vue que le leur.
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send(file.body);
  }
}
