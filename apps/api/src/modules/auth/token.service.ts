import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { base64UrlToUtf8, generateSecureToken, utf8ToBase64Url } from '@try/utils';
import type { Clock } from '@try/utils';
import type { AppConfig } from '@try/config';
import type { BusinessRole, UserRole } from '@try/contracts';
import { CONFIG } from '../../common/config.module.js';
import { CLOCK } from '../../common/clock.js';
import { ApiException } from '../../common/errors/api-exception.js';

/**
 * Access-token claims.
 *
 * Business memberships are embedded so the common case — "is this staff member
 * allowed to act on this venue?" — needs no database round trip. The trade-off is
 * that a revoked membership stays valid until the short access token expires;
 * with a 15-minute TTL that window is acceptable, and anything destructive
 * re-checks membership against the database anyway.
 */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
  memberships: { businessId: string; role: BusinessRole }[];
  /** Issued-at and expiry, seconds since epoch. */
  iat: number;
  exp: number;
}

interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

/**
 * A deliberately small HS256 implementation rather than a JWT library.
 *
 * TRY issues and verifies its own tokens with one symmetric secret; a full JOSE
 * dependency would add algorithm negotiation, and algorithm confusion ("alg":
 * "none", RS256/HS256 mixups) is the classic way JWT auth gets broken. Here the
 * algorithm is fixed and the header is verified, so there is nothing to confuse.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  issueAccessToken(input: {
    userId: string;
    email: string;
    role: UserRole;
    memberships: { businessId: string; role: BusinessRole }[];
  }): { token: string; expiresIn: number } {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const expiresIn = this.config.ACCESS_TOKEN_TTL_SECONDS;

    const claims: AccessTokenClaims = {
      sub: input.userId,
      email: input.email,
      role: input.role,
      memberships: input.memberships,
      iat: issuedAt,
      exp: issuedAt + expiresIn,
    };

    const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
    const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(
      JSON.stringify(claims),
    )}`;

    return { token: `${signingInput}.${this.signature(signingInput)}`, expiresIn };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new ApiException('UNAUTHENTICATED');

    const [encodedHeader, encodedClaims, signature] = parts as [string, string, string];

    if (!this.signatureMatches(`${encodedHeader}.${encodedClaims}`, signature)) {
      throw new ApiException('UNAUTHENTICATED');
    }

    let header: JwtHeader;
    let claims: AccessTokenClaims;
    try {
      header = JSON.parse(base64UrlToUtf8(encodedHeader)) as JwtHeader;
      claims = JSON.parse(base64UrlToUtf8(encodedClaims)) as AccessTokenClaims;
    } catch {
      throw new ApiException('UNAUTHENTICATED');
    }

    // Reject anything that is not the algorithm we issue, even though the
    // signature already matched — defence in depth against future refactors.
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new ApiException('UNAUTHENTICATED');
    }

    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
      throw new ApiException('UNAUTHENTICATED', 'Ta session a expiré. Reconnecte-toi.');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new ApiException('UNAUTHENTICATED');
    }

    return { ...claims, memberships: claims.memberships ?? [] };
  }

  /** Opaque, high-entropy refresh token. Only its hash is ever persisted. */
  generateRefreshToken(): string {
    return generateSecureToken(48);
  }

  private signature(signingInput: string): string {
    const digest = createHmac('sha256', this.config.JWT_SECRET).update(signingInput).digest();
    return Buffer.from(digest).toString('base64url');
  }

  private signatureMatches(signingInput: string, provided: string): boolean {
    const expected = Buffer.from(this.signature(signingInput), 'utf8');
    const actual = Buffer.from(provided, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}
