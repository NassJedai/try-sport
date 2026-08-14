import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuidSchema } from '@try/contracts';
import type { OfferStatus, VenueStatus } from '@try/contracts';
import { Roles } from '../../common/auth/auth.guard.js';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { zodBody, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ModerationService, type ModerationQueueItem } from './moderation.service.js';

const venueDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE']),
  reason: z.string().max(1000).optional(),
});

const offerDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'PAUSE']),
  reason: z.string().max(1000).optional(),
});

/**
 * Admin console API.
 *
 * `@Roles` is enforced by the global guard from the token's verified claims, and
 * the service re-checks it — the console's own routing is a convenience, never
 * the control.
 */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Platform metrics: MAU, supply, bookings, GMV, conversions' })
  overview(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, number>> {
    return this.moderation.overview(user);
  }

  @Get('moderation/queue')
  @ApiOperation({ summary: 'Venues and offers awaiting review, oldest first' })
  queue(@CurrentUser() user: AuthenticatedUser): Promise<{ items: ModerationQueueItem[] }> {
    return this.moderation.queue(user);
  }

  @Post('venues/:id/decision')
  @ApiOperation({ summary: 'Approve, reject, suspend or reinstate a venue' })
  decideVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) venueId: string,
    @Body(zodBody(venueDecisionSchema)) body: unknown,
  ): Promise<{ status: VenueStatus }> {
    const dto = body as z.infer<typeof venueDecisionSchema>;
    return this.moderation.decideVenue({ actor: user, venueId, ...dto });
  }

  @Post('offers/:id/decision')
  @ApiOperation({ summary: 'Approve, reject or pause an offer' })
  decideOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) offerId: string,
    @Body(zodBody(offerDecisionSchema)) body: unknown,
  ): Promise<{ status: OfferStatus }> {
    const dto = body as z.infer<typeof offerDecisionSchema>;
    return this.moderation.decideOffer({ actor: user, offerId, ...dto });
  }
}
