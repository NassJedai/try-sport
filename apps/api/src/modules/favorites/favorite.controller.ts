import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { uuidSchema } from '@try/contracts';
import type { OfferCardDto } from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { FavoriteService } from './favorite.service.js';

@ApiTags('favorites')
@Controller({ path: 'favorites', version: '1' })
export class FavoriteController {
  constructor(private readonly favorites: FavoriteService) {}

  @Get()
  @ApiOperation({ summary: 'Saved offers, newest first' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<{ items: OfferCardDto[] }> {
    return this.favorites.list(user.id);
  }

  /**
   * Explicit PUT-like semantics alongside the toggle.
   *
   * The client updates optimistically, so it already knows the state it wants;
   * sending that state makes a retry converge, where a blind toggle would undo
   * itself.
   */
  @Post(':offerId')
  @ApiOperation({ summary: 'Set the favourite state for an offer' })
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('offerId', new ZodValidationPipe(uuidSchema)) offerId: string,
    @Body() body: { isFavorite?: boolean },
  ): Promise<{ isFavorite: boolean }> {
    if (typeof body?.isFavorite === 'boolean') {
      return this.favorites.setFavorite({ userId: user.id, offerId, isFavorite: body.isFavorite });
    }
    return this.favorites.toggle({ userId: user.id, offerId });
  }

  @Delete(':offerId')
  @ApiOperation({ summary: 'Remove an offer from favourites' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('offerId', new ZodValidationPipe(uuidSchema)) offerId: string,
  ): Promise<{ isFavorite: boolean }> {
    return this.favorites.setFavorite({ userId: user.id, offerId, isFavorite: false });
  }
}
