import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  discoveryHomeQuerySchema,
  mapOffersQuerySchema,
  searchOffersQuerySchema,
} from '@try/contracts';
import type {
  DiscoveryHomeDto,
  MapOffersResponseDto,
  OfferCardPageDto,
} from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { OptionalAuth } from '../../common/auth/auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.guard.js';
import { zodBody, zodQuery } from '../../common/zod-validation.pipe.js';
import { DiscoveryService } from './discovery.service.js';

@ApiTags('discovery')
@Controller({ path: 'discovery', version: '1' })
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  /**
   * Anonymous browsing is a product decision: asking someone to sign up before
   * they can see what is nearby is the fastest way to lose them. Personalisation
   * layers on when a token is present.
   */
  @Get('home')
  @OptionalAuth()
  @ApiOperation({ summary: 'Aggregated home screen: sections, categories, city' })
  home(
    @Query(zodQuery(discoveryHomeQuerySchema)) query: unknown,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<DiscoveryHomeDto> {
    return this.discovery.home(
      query as Parameters<DiscoveryService['home']>[0],
      user?.id ?? null,
    );
  }

  @Get('search')
  @OptionalAuth()
  @RateLimit('search')
  @ApiOperation({ summary: 'Filterable, cursor-paginated offer search' })
  search(
    @Query(zodQuery(searchOffersQuerySchema)) query: unknown,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<OfferCardPageDto> {
    return this.discovery.search(
      query as Parameters<DiscoveryService['search']>[0],
      user?.id ?? null,
    );
  }

  /**
   * POST because a viewport is a structured object; encoding four floats plus
   * filter arrays into a query string is lossy and awkward to cache anyway.
   */
  @Post('map')
  @OptionalAuth()
  @RateLimit('search')
  @ApiOperation({ summary: 'Offer pins within a map viewport' })
  map(@Body(zodBody(mapOffersQuerySchema)) body: unknown): Promise<MapOffersResponseDto> {
    return this.discovery.map(body as Parameters<DiscoveryService['map']>[0]);
  }
}
