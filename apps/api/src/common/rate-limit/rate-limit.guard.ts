import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { ApiException } from '../errors/api-exception.js';
import type { RequestWithUser } from '../auth/current-user.js';
import { RateLimiter } from './rate-limiter.js';
import type { RateLimitName } from './rate-limiter.js';

export const RATE_LIMIT_KEY = 'ratelimit:name';

export const RateLimit = (name: RateLimitName): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, name);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const name = this.reflector.getAllAndOverride<RateLimitName>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!name) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();

    /**
     * Authenticated traffic is limited per user, anonymous traffic per IP.
     * Limiting purely by IP would throttle everyone behind one corporate NAT or
     * mobile carrier gateway together.
     */
    const identifier = request.user?.id ?? clientIp(request);

    const result = await this.rateLimiter.consume(name, identifier);

    const reply = http.getResponse<FastifyReply>();
    void reply.header('x-ratelimit-remaining', String(result.remaining));

    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiException('RATE_LIMITED', undefined, undefined, {
        limit: name,
        identifier,
      });
    }

    return true;
  }
}

/**
 * Trusts `x-forwarded-for` only because Fastify is configured with
 * `trustProxy` for the known ingress; `request.ip` already reflects that.
 */
function clientIp(request: RequestWithUser): string {
  return request.ip || 'unknown';
}
