import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  refreshTokenSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from '@try/contracts';
import type { AuthSessionDto, ViewerDto } from '@try/contracts';
import { Public } from '../../common/auth/auth.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.guard.js';
import { zodBody } from '../../common/zod-validation.pipe.js';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user.js';
import { AuthService } from './auth.service.js';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @Public()
  @RateLimit('otpRequest')
  @ApiOperation({ summary: 'Send a one-time login code by email' })
  requestOtp(@Body(zodBody(requestOtpSchema)) body: unknown): Promise<{ sent: true }> {
    return this.auth.requestOtp(body as Parameters<AuthService['requestOtp']>[0]);
  }

  @Post('otp/verify')
  @Public()
  @RateLimit('otpVerify')
  @ApiOperation({ summary: 'Exchange a login code for a session' })
  verifyOtp(@Body(zodBody(verifyOtpSchema)) body: unknown): Promise<AuthSessionDto> {
    return this.auth.verifyOtp(body as Parameters<AuthService['verifyOtp']>[0]);
  }

  @Post('refresh')
  @Public()
  @ApiOperation({ summary: 'Rotate a refresh token' })
  refresh(@Body(zodBody(refreshTokenSchema)) body: unknown): Promise<AuthSessionDto> {
    return this.auth.refresh((body as { refreshToken: string }).refreshToken);
  }

  @Post('logout')
  @Public()
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body(zodBody(refreshTokenSchema)) body: unknown): Promise<{ ok: true }> {
    await this.auth.logout((body as { refreshToken: string }).refreshToken);
    return { ok: true };
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<ViewerDto> {
    return this.auth.getViewer(user.id);
  }
}
