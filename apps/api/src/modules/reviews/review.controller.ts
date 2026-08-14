import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { submitReviewSchema, uuidSchema } from '@try/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.guard.js';
import { zodBody, ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ReviewService } from './review.service.js';

@ApiTags('reviews')
@Controller({ path: 'bookings', version: '1' })
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  /**
   * Rating plus the continuation answer, submitted together.
   *
   * One screen, one submit: splitting them would lose the second answer for most
   * users, and the continuation answer is the one that pays for the platform.
   */
  @Post(':id/review')
  @RateLimit('review')
  @ApiOperation({ summary: 'Rate an attended session and answer the continuation question' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) reservationId: string,
    @Body(zodBody(submitReviewSchema)) body: unknown,
  ): Promise<{ reviewId: string }> {
    return this.reviews.submit({
      userId: user.id,
      reservationId,
      dto: body as Parameters<ReviewService['submit']>[0]['dto'],
    });
  }

  @Get('pending-reviews')
  @ApiOperation({ summary: 'Attended sessions still awaiting a review' })
  pending(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ reservationId: string; offerTitle: string }[]> {
    return this.reviews.listPendingReviews(user.id);
  }
}
