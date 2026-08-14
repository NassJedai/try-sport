import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@try/contracts';
import { runWithRequestContext, getRequestContext } from '@try/logger';
import { ApiException } from '../errors/api-exception.js';
import { TokenService } from '../../modules/auth/token.service.js';
import type { RequestWithUser } from './current-user.js';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const OPTIONAL_AUTH_KEY = 'auth:optional';

/** Endpoint requires no authentication (login, discovery browsing, health). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Endpoint works anonymously but personalises when a token is present — the offer
 * detail page, which shows favourites and trial eligibility only to signed-in users.
 */
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(OPTIONAL_AUTH_KEY, true);

export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * The single gate for authentication and platform-level authorisation.
 *
 * Registered globally, so an endpoint is protected unless it explicitly opts out.
 * Forgetting a decorator therefore fails closed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ?? false;
    const isOptional =
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets) ?? false;
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets) ?? [];

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      if (isPublic || isOptional) return true;
      throw new ApiException('UNAUTHENTICATED');
    }

    // On a public route an invalid token is ignored rather than fatal, so an
    // expired session never blocks someone from browsing offers.
    let claims;
    try {
      claims = this.tokenService.verifyAccessToken(token);
    } catch (error) {
      if (isPublic || isOptional) return true;
      throw error;
    }

    request.user = {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
      memberships: claims.memberships,
    };

    // Attach the principal to the log context so every line of this request is
    // attributable without the handler passing a user id around.
    const context_ = getRequestContext();
    if (context_) context_.userId = claims.sub;

    if (requiredRoles.length > 0 && !requiredRoles.includes(claims.role)) {
      throw ApiException.forbidden(
        `role ${claims.role} is not in [${requiredRoles.join(', ')}]`,
      );
    }

    return true;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim();
}

export { runWithRequestContext };
