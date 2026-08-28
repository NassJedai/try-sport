import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  createBusinessSchema,
  createOfferSchema,
  createVenueSchema,
  recurringScheduleSchema,
  updateOfferSchema,
  updateVenueSchema,
  uuidSchema,
} from '@try/contracts';
import type { BusinessOfferDto, BusinessVenueDto } from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { zodBody, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OnboardingService } from './onboarding.service.js';
import { ScheduleService } from '../scheduling/schedule.service.js';

/**
 * Self-serve supply onboarding: business → venue → offer → schedule → submit.
 *
 * Nothing here can publish itself; `submit` moves an entity into the moderation
 * queue and an admin decides.
 */
@ApiTags('business')
@Controller({ version: '1' })
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly schedules: ScheduleService,
  ) {}

  @Post('businesses')
  @ApiOperation({ summary: 'Create a business; the caller becomes its OWNER' })
  createBusiness(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createBusinessSchema)) body: unknown,
  ): Promise<{ businessId: string }> {
    return this.onboarding.createBusiness({
      actor: user,
      dto: body as Parameters<OnboardingService['createBusiness']>[0]['dto'],
    });
  }

  @Post('businesses/:businessId/venues')
  @ApiOperation({ summary: 'Add a venue to a business' })
  createVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
    @Body(zodBody(createVenueSchema)) body: unknown,
  ): Promise<{ venueId: string }> {
    return this.onboarding.createVenue({
      actor: user,
      businessId,
      dto: body as Parameters<OnboardingService['createVenue']>[0]['dto'],
    });
  }

  @Post('offers')
  @ApiOperation({ summary: 'Create a draft offer for a venue' })
  createOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createOfferSchema)) body: unknown,
  ): Promise<{ offerId: string }> {
    return this.onboarding.createOffer({
      actor: user,
      dto: body as Parameters<OnboardingService['createOffer']>[0]['dto'],
    });
  }

  @Post('schedules')
  @ApiOperation({ summary: 'Create a recurring schedule and materialise its slots' })
  createSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(recurringScheduleSchema)) body: unknown,
  ): Promise<{ scheduleId: string; slotsCreated: number }> {
    return this.schedules.createRecurring({
      actor: user,
      dto: body as Parameters<ScheduleService['createRecurring']>[0]['dto'],
    });
  }

  @Post('venues/:id/submit')
  @ApiOperation({ summary: 'Submit a venue for moderation' })
  async submitVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) venueId: string,
  ): Promise<{ status: 'PENDING_APPROVAL' }> {
    await this.onboarding.submitVenue({ actor: user, venueId });
    return { status: 'PENDING_APPROVAL' };
  }

  @Post('offers/:id/submit')
  @ApiOperation({ summary: 'Submit an offer for moderation' })
  async submitOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) offerId: string,
  ): Promise<{ status: 'PENDING_APPROVAL' }> {
    await this.onboarding.submitOffer({ actor: user, offerId });
    return { status: 'PENDING_APPROVAL' };
  }

  @Post('venues/:id/withdraw')
  @ApiOperation({ summary: 'Withdraw a venue submission back to draft, to edit it' })
  async withdrawVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) venueId: string,
  ): Promise<{ status: 'DRAFT' }> {
    await this.onboarding.withdrawVenue({ actor: user, venueId });
    return { status: 'DRAFT' };
  }

  @Post('offers/:id/withdraw')
  @ApiOperation({ summary: 'Withdraw an offer submission back to draft, to edit it' })
  async withdrawOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) offerId: string,
  ): Promise<{ status: 'DRAFT' }> {
    await this.onboarding.withdrawOffer({ actor: user, offerId });
    return { status: 'DRAFT' };
  }

  @Patch('venues/:id')
  @ApiOperation({ summary: "Update a venue's own fields; identity changes on a live venue notify admin" })
  updateVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) venueId: string,
    @Body(zodBody(updateVenueSchema)) body: unknown,
  ): Promise<BusinessVenueDto> {
    return this.onboarding.updateVenue({
      actor: user,
      venueId,
      dto: body as Parameters<OnboardingService['updateVenue']>[0]['dto'],
    });
  }

  @Patch('offers/:id')
  @ApiOperation({
    summary: "Update an offer's own fields; moderated fields on a live offer notify admin, currency is locked",
  })
  updateOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) offerId: string,
    @Body(zodBody(updateOfferSchema)) body: unknown,
  ): Promise<BusinessOfferDto> {
    return this.onboarding.updateOffer({
      actor: user,
      offerId,
      dto: body as Parameters<OnboardingService['updateOffer']>[0]['dto'],
    });
  }

  @Post('offers/:id/pause')
  @ApiOperation({ summary: 'Pause or resume a live offer' })
  async setPaused(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) offerId: string,
    @Body(zodBody(z.object({ paused: z.boolean() }))) body: unknown,
  ): Promise<{ ok: true }> {
    await this.onboarding.setOfferPaused({
      actor: user,
      offerId,
      paused: (body as { paused: boolean }).paused,
    });
    return { ok: true };
  }

  @Post('slots/:id/cancel')
  @ApiOperation({ summary: 'Cancel a slot and release everyone booked into it' })
  cancelSlot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) slotId: string,
    @Body(zodBody(z.object({ reason: z.string().min(3).max(300) }))) body: unknown,
  ): Promise<{ affectedReservations: number }> {
    return this.schedules.cancelSlot({
      actor: user,
      slotId,
      reason: (body as { reason: string }).reason,
    });
  }
}
