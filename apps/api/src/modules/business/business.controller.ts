import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  businessMetricsQuerySchema,
  listBusinessBookingsQuerySchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  uuidSchema,
} from '@try/contracts';
import type {
  BusinessBookingDto,
  BusinessMetricsDto,
  BusinessOfferDto,
  BusinessSlotDto,
  LeadDto,
} from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { zodBody, zodQuery, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { BusinessService } from './business.service.js';

/**
 * Business-facing endpoints.
 *
 * Every handler resolves authorisation from the caller's verified membership
 * before touching data — the businessId in the path is a lookup key, never a
 * grant. This is what stops business A reading business B's leads.
 */
@ApiTags('business')
@Controller({ path: 'businesses', version: '1' })
export class BusinessController {
  constructor(private readonly business: BusinessService) {}

  @Get(':businessId/metrics')
  @ApiOperation({ summary: 'Trial → check-in → conversion funnel for a period' })
  metrics(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
    @Query(zodQuery(businessMetricsQuerySchema)) query: unknown,
  ): Promise<BusinessMetricsDto> {
    this.business.assertMember(user, businessId, 'MANAGER');
    const dto = query as { venueId?: string; from: string; to: string };

    return this.business.metrics({
      businessId,
      venueId: dto.venueId,
      from: new Date(dto.from),
      to: new Date(`${dto.to}T23:59:59.999Z`),
    });
  }

  @Get(':businessId/offers')
  @ApiOperation({ summary: 'Own offers with moderation status and upcoming slot counts' })
  offers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
  ): Promise<{ items: BusinessOfferDto[] }> {
    // STAFF voit ; les mutations (pause, annulation) exigent MANAGER plus loin.
    this.business.assertMember(user, businessId, 'STAFF');
    return this.business.listOffers(businessId);
  }

  @Get(':businessId/slots')
  @ApiOperation({ summary: 'Upcoming slots with fill rates' })
  slots(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
    @Query('days') days?: string,
  ): Promise<{ items: BusinessSlotDto[] }> {
    this.business.assertMember(user, businessId, 'STAFF');
    // Borné : le planning est un écran de travail, pas un export.
    const horizon = Math.min(Math.max(Number(days) || 7, 1), 30);
    return this.business.listSlots(businessId, horizon);
  }

  @Get(':businessId/bookings')
  @ApiOperation({ summary: "Today's bookings at the front desk" })
  bookings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
    @Query(zodQuery(listBusinessBookingsQuerySchema)) query: unknown,
  ): Promise<{ items: BusinessBookingDto[]; nextCursor: string | null }> {
    // STAFF is enough: the person on the desk needs the list to check people in.
    this.business.assertMember(user, businessId, 'STAFF');
    return this.business.listBookings(
      businessId,
      query as Parameters<BusinessService['listBookings']>[1],
    );
  }

  @Get(':businessId/leads')
  @ApiOperation({ summary: 'CRM pipeline of attended trials' })
  leads(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
    @Query(zodQuery(listLeadsQuerySchema)) query: unknown,
  ): Promise<{ items: LeadDto[]; nextCursor: string | null }> {
    // Leads carry personal data, so front-desk staff do not see them.
    this.business.assertMember(user, businessId, 'MANAGER');
    return this.business.listLeads(
      businessId,
      query as Parameters<BusinessService['listLeads']>[1],
    );
  }

  @Patch(':businessId/leads/:leadId')
  @ApiOperation({ summary: 'Advance a lead, including marking it converted' })
  updateLead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('businessId', new ZodValidationPipe(uuidSchema)) businessId: string,
    @Param('leadId', new ZodValidationPipe(uuidSchema)) leadId: string,
    @Body(zodBody(updateLeadSchema)) body: unknown,
  ): Promise<LeadDto> {
    this.business.assertMember(user, businessId, 'MANAGER');
    return this.business.updateLead({
      actor: user,
      businessId,
      leadId,
      dto: body as Parameters<BusinessService['updateLead']>[0]['dto'],
    });
  }
}
