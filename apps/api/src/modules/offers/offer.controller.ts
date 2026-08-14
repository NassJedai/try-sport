import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { availabilityQuerySchema, uuidSchema } from '@try/contracts';
import type { AvailabilityResponseDto, OfferDetailDto } from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { OptionalAuth } from '../../common/auth/auth.guard.js';
import { zodQuery, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { OfferService } from './offer.service.js';

@ApiTags('offers')
@Controller({ path: 'offers', version: '1' })
export class OfferController {
  constructor(private readonly offers: OfferService) {}

  @Get(':id')
  @OptionalAuth()
  @ApiOperation({ summary: 'Full offer detail, personalised when authenticated' })
  detail(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<OfferDetailDto> {
    return this.offers.findDetail(id, user?.id ?? null);
  }

  @Get(':id/availability')
  @OptionalAuth()
  @ApiOperation({ summary: 'Bookable slots grouped by venue-local day' })
  availability(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(zodQuery(availabilityQuerySchema)) query: unknown,
  ): Promise<AvailabilityResponseDto> {
    return this.offers.findAvailability(
      id,
      query as Parameters<OfferService['findAvailability']>[1],
    );
  }
}
