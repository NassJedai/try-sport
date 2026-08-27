import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  cancelBookingSchema,
  createBookingSchema,
  listBookingsQuerySchema,
  uuidSchema,
} from '@try/contracts';
import type { BookingDto, BookingPageDto } from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.guard.js';
import { zodBody, zodQuery, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { BookingService } from './booking.service.js';
import type { CreateBookingResult } from './booking.service.js';
import { BookingQueryService } from './booking-query.service.js';

@ApiTags('bookings')
@Controller({ path: 'bookings', version: '1' })
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly queries: BookingQueryService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Creating a booking requires an Idempotency-Key.
   *
   * It is mandatory rather than optional because this endpoint can move money and
   * consume a trial: a retry after a dropped mobile connection must resolve to the
   * same booking, not a second one.
   */
  @Post()
  @RateLimit('booking')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Book a slot (free or paid)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createBookingSchema)) body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateBookingResult> {
    const key = IdempotencyService.requireKey(idempotencyKey);
    const dto = body as Parameters<BookingService['create']>[0]['dto'];

    const outcome = await this.idempotency.execute(
      { key, userId: user.id, endpoint: 'POST /v1/bookings', payload: dto },
      () => this.bookings.create({ userId: user.id, dto }),
    );

    return outcome.result;
  }

  @Get()
  @ApiOperation({ summary: "The signed-in user's bookings" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodQuery(listBookingsQuerySchema)) query: unknown,
  ): Promise<BookingPageDto> {
    return this.queries.listForUser(
      user.id,
      query as Parameters<BookingQueryService['listForUser']>[1],
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Booking detail including the QR check-in token' })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<BookingDto> {
    return this.queries.findForUser(user.id, id);
  }

  @Post(':id/cancel')
  @RateLimit('booking')
  @ApiOperation({ summary: 'Cancel a booking and release its place' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(cancelBookingSchema)) body: unknown,
  ): Promise<{ refunded: boolean }> {
    const dto = body as { reason?: string };
    return this.bookings.cancel({ reservationId: id, userId: user.id, reason: dto.reason });
  }

  /**
   * Business-actor endpoint, unlike every other route on this controller:
   * authorisation is resolved from the reservation's business membership
   * (`hasBusinessRole`), not from `reservation.userId`. The client sends
   * nothing but the id — which status it starts from, whether the session is
   * actually over, and whether the window has closed are all resolved
   * server-side. See `BookingService.markNoShow` for the full rationale.
   */
  @Post(':id/no-show')
  @RateLimit('checkIn')
  @ApiOperation({ summary: 'Business staff: mark a confirmed booking as a no-show' })
  markNoShow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ reservationId: string; status: 'NO_SHOW' }> {
    return this.bookings.markNoShow({ actor: user, reservationId: id });
  }
}
