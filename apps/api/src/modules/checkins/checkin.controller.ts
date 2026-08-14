import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { checkInSchema } from '@try/contracts';
import type { CheckInResultDto } from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.guard.js';
import { zodBody } from '../../common/zod-validation.pipe.js';
import { CheckInService } from './checkin.service.js';

@ApiTags('check-in')
@Controller({ path: 'checkins', version: '1' })
export class CheckInController {
  constructor(private readonly checkIns: CheckInService) {}

  /**
   * Called by staff at the venue. Authorisation is resolved from the reservation's
   * business inside the service, so a member of one business cannot check in
   * another's attendee even with a valid token.
   */
  @Post()
  @RateLimit('checkIn')
  @ApiOperation({ summary: 'Validate a QR token or short code at the venue' })
  checkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(checkInSchema)) body: unknown,
  ): Promise<CheckInResultDto> {
    return this.checkIns.checkIn({
      actor: user,
      dto: body as Parameters<CheckInService['checkIn']>[0]['dto'],
    });
  }
}
