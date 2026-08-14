import { describe, expect, it } from 'vitest';
import { FixedClock, utf8ToBase64Url } from '@try/utils';
import type { AppConfig } from '@try/config';
import { TokenService } from './token.service.js';
import { ApiException } from '../../common/errors/api-exception.js';

const config = {
  JWT_SECRET: 'a'.repeat(32),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 60,
} as AppConfig;

const NOW = new Date('2026-07-15T10:00:00Z');

function makeService(clock = new FixedClock(NOW)) {
  return { service: new TokenService(config, clock), clock };
}

const subject = {
  userId: '11111111-1111-1111-1111-111111111111',
  email: 'user@try.local',
  role: 'USER' as const,
  memberships: [{ businessId: 'b1', role: 'OWNER' as const }],
};

describe('TokenService', () => {
  it('round-trips claims through a signed token', () => {
    const { service } = makeService();
    const { token, expiresIn } = service.issueAccessToken(subject);

    const claims = service.verifyAccessToken(token);
    expect(claims.sub).toBe(subject.userId);
    expect(claims.role).toBe('USER');
    expect(claims.memberships).toEqual(subject.memberships);
    expect(expiresIn).toBe(900);
  });

  it('rejects a token whose payload was tampered with', () => {
    const { service } = makeService();
    const { token } = service.issueAccessToken(subject);

    // Escalate the role in the payload while keeping the original signature.
    const [header, , signature] = token.split('.') as [string, string, string];
    const forgedClaims = utf8ToBase64Url(
      JSON.stringify({
        sub: subject.userId,
        email: subject.email,
        role: 'SUPER_ADMIN',
        memberships: [],
        iat: Math.floor(NOW.getTime() / 1000),
        exp: Math.floor(NOW.getTime() / 1000) + 900,
      }),
    );

    expect(() => service.verifyAccessToken(`${header}.${forgedClaims}.${signature}`)).toThrow(
      ApiException,
    );
  });

  it('rejects the "alg: none" downgrade', () => {
    const { service } = makeService();
    const header = utf8ToBase64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const claims = utf8ToBase64Url(
      JSON.stringify({ sub: 'attacker', role: 'SUPER_ADMIN', exp: 9_999_999_999 }),
    );

    expect(() => service.verifyAccessToken(`${header}.${claims}.`)).toThrow(ApiException);
    expect(() => service.verifyAccessToken(`${header}.${claims}.anything`)).toThrow(ApiException);
  });

  it('rejects a token signed with a different secret', () => {
    const { service } = makeService();
    const other = new TokenService(
      { ...config, JWT_SECRET: 'b'.repeat(32) } as AppConfig,
      new FixedClock(NOW),
    );
    const { token } = other.issueAccessToken(subject);

    expect(() => service.verifyAccessToken(token)).toThrow(ApiException);
  });

  it('rejects an expired token', () => {
    const clock = new FixedClock(NOW);
    const { service } = makeService(clock);
    const { token } = service.issueAccessToken(subject);

    // Valid right up to expiry...
    clock.advance(899_000);
    expect(service.verifyAccessToken(token).sub).toBe(subject.userId);

    // ...and refused after it.
    clock.advance(2_000);
    expect(() => service.verifyAccessToken(token)).toThrow(/session a expiré/i);
  });

  it('rejects malformed tokens instead of throwing an unhandled error', () => {
    const { service } = makeService();
    for (const malformed of ['', 'abc', 'a.b', 'a.b.c.d', '...', 'not.a.token']) {
      expect(() => service.verifyAccessToken(malformed)).toThrow(ApiException);
    }
  });

  it('generates refresh tokens with high entropy and no collisions', () => {
    const { service } = makeService();
    const tokens = new Set(Array.from({ length: 500 }, () => service.generateRefreshToken()));
    expect(tokens.size).toBe(500);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });
});
