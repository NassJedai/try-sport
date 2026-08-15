import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { generateNumericOtp } from '@try/utils';
import type { Clock } from '@try/utils';
import { schema } from '@try/database';
import type { Database } from '@try/database';
import type { AppConfig } from '@try/config';
import type { AuthSessionDto, RequestOtpDto, VerifyOtpDto, ViewerDto } from '@try/contracts';
import type { Logger } from '@try/logger';
import { DATABASE } from '../../common/database.module.js';
import { CLOCK } from '../../common/clock.js';
import { CONFIG } from '../../common/config.module.js';
import { LOGGER } from '../../common/logger.module.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { CryptoService } from '../../common/crypto.service.js';
import { TokenService } from './token.service.js';
import { NotificationService } from '../notifications/notification.service.js';

const OTP_TTL_MINUTES = 10;
/** Attempts allowed against one issued code before it is burned. */
const OTP_MAX_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Issues a login code.
   *
   * Always reports success, whether or not the address has an account: a
   * different response for unknown emails turns this endpoint into an account
   * enumeration oracle.
   */
  async requestOtp(dto: RequestOtpDto): Promise<{ sent: true }> {
    const now = this.clock.now();
    const code = generateNumericOtp(6);

    await this.db.insert(schema.otpCodes).values({
      email: dto.email,
      // Only the hash is stored; a database leak must not yield working codes.
      codeHash: this.crypto.hashToken(code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MINUTES * 60_000),
    });

    await this.notifications.sendLoginCode({
      email: dto.email,
      code,
      locale: dto.locale,
      expiresInMinutes: OTP_TTL_MINUTES,
    });

    // Local-only affordance so a developer without a mail server can sign in.
    // Configuration refuses to boot with this enabled outside local.
    //
    // The field is `devLoginCode`, not `code`: `code` is on the logger's
    // redaction list, and the first live run printed `[redacted]` — the
    // anti-leak guard silently neutralised the one log line meant to leak.
    if (this.config.AUTH_DEV_ECHO_OTP && this.config.isLocal) {
      this.logger.warn({ email: dto.email, devLoginCode: code }, 'DEV ONLY: login code issued');
    }

    return { sent: true };
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<AuthSessionDto> {
    const now = this.clock.now();

    const [record] = await this.db
      .select()
      .from(schema.otpCodes)
      .where(
        and(
          eq(schema.otpCodes.email, dto.email),
          isNull(schema.otpCodes.consumedAt),
          gt(schema.otpCodes.expiresAt, now),
        ),
      )
      .orderBy(sql`${schema.otpCodes.createdAt} DESC`)
      .limit(1);

    if (!record) {
      throw new ApiException('UNAUTHENTICATED', 'Code invalide ou expiré. Demande un nouveau code.');
    }

    if (record.attemptCount >= OTP_MAX_ATTEMPTS) {
      throw new ApiException('RATE_LIMITED', 'Trop de tentatives. Demande un nouveau code.');
    }

    if (!this.crypto.safeEqual(this.crypto.hashToken(dto.code), record.codeHash)) {
      await this.db
        .update(schema.otpCodes)
        .set({ attemptCount: sql`${schema.otpCodes.attemptCount} + 1` })
        .where(eq(schema.otpCodes.id, record.id));

      throw new ApiException('UNAUTHENTICATED', 'Code invalide ou expiré. Demande un nouveau code.');
    }

    // Single use: burn the code before issuing any token.
    await this.db
      .update(schema.otpCodes)
      .set({ consumedAt: now })
      .where(eq(schema.otpCodes.id, record.id));

    const { user, isNewUser } = await this.findOrCreateUser(dto.email, now);

    if (isNewUser && dto.attribution) {
      await this.db.insert(schema.attributions).values({
        userId: user.id,
        source: (dto.attribution.source ?? 'organic') as 'organic',
        medium: dto.attribution.medium ?? null,
        campaign: dto.attribution.campaign ?? null,
        content: dto.attribution.content ?? null,
        term: dto.attribution.term ?? null,
        referralCode: dto.attribution.referralCode ?? null,
        landingOfferId: dto.attribution.landingOfferId ?? null,
        landingVenueId: dto.attribution.landingVenueId ?? null,
      });
    }

    return this.issueSession(user.id, isNewUser);
  }

  /**
   * Rotates a refresh token.
   *
   * Reuse of an already-rotated token means it was captured, so the entire token
   * family is revoked rather than just the presented one — the attacker and the
   * legitimate user both get logged out, which is the safe outcome.
   */
  async refresh(refreshToken: string): Promise<AuthSessionDto> {
    const now = this.clock.now();
    const tokenHash = this.crypto.hashToken(refreshToken);

    const [record] = await this.db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!record) throw new ApiException('UNAUTHENTICATED');

    if (record.revokedAt || record.replacedByTokenId) {
      this.logger.warn(
        { userId: record.userId, familyId: record.familyId },
        'refresh token reuse detected; revoking family',
      );
      await this.db
        .update(schema.refreshTokens)
        .set({ revokedAt: now })
        .where(eq(schema.refreshTokens.familyId, record.familyId));
      throw new ApiException('UNAUTHENTICATED', 'Session expirée. Reconnecte-toi.');
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new ApiException('UNAUTHENTICATED', 'Session expirée. Reconnecte-toi.');
    }

    return this.issueSession(record.userId, false, record.familyId, record.id);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: this.clock.now() })
      .where(eq(schema.refreshTokens.tokenHash, this.crypto.hashToken(refreshToken)));
  }

  async getViewer(userId: string): Promise<ViewerDto> {
    const [row] = await this.db
      .select({ user: schema.users, profile: schema.profiles })
      .from(schema.users)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.users.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!row) throw ApiException.notFound('user', userId);

    const [memberships, interests] = await Promise.all([
      this.db
        .select({
          businessId: schema.businessMembers.businessId,
          role: schema.businessMembers.role,
          businessName: schema.businesses.name,
        })
        .from(schema.businessMembers)
        .innerJoin(schema.businesses, eq(schema.businesses.id, schema.businessMembers.businessId))
        .where(eq(schema.businessMembers.userId, userId)),
      this.db
        .select({ categoryId: schema.userInterests.categoryId })
        .from(schema.userInterests)
        .where(eq(schema.userInterests.userId, userId)),
    ]);

    return {
      id: row.user.id,
      email: row.user.email,
      firstName: row.profile?.firstName ?? null,
      lastName: row.profile?.lastName ?? null,
      avatarUrl: row.profile?.avatarUrl ?? null,
      locale: row.profile?.locale ?? 'fr',
      roles: [row.user.role],
      businessMemberships: memberships,
      interests: interests.map((interest) => interest.categoryId),
      onboardingCompletedAt: row.profile?.onboardingCompletedAt?.toISOString() ?? null,
      notificationPreferences: row.profile?.notificationPreferences ?? {
        bookingUpdates: true,
        reminders: true,
        recommendations: true,
        marketing: false,
      },
      createdAt: row.user.createdAt.toISOString(),
    };
  }

  private async findOrCreateUser(
    email: string,
    now: Date,
  ): Promise<{ user: typeof schema.users.$inferSelect; isNewUser: boolean }> {
    const [existing] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existing) {
      if (existing.isSuspended) {
        throw ApiException.forbidden('account suspended');
      }
      await this.db
        .update(schema.users)
        .set({ lastSeenAt: now, emailVerifiedAt: existing.emailVerifiedAt ?? now })
        .where(eq(schema.users.id, existing.id));
      return { user: existing, isNewUser: false };
    }

    const [created] = await this.db
      .insert(schema.users)
      .values({ email, role: 'USER', emailVerifiedAt: now, lastSeenAt: now })
      .returning();

    if (!created) throw new ApiException('INTERNAL_ERROR');

    await this.db.insert(schema.profiles).values({ userId: created.id });

    return { user: created, isNewUser: true };
  }

  private async issueSession(
    userId: string,
    isNewUser: boolean,
    familyId?: string,
    replacedTokenId?: string,
  ): Promise<AuthSessionDto> {
    const now = this.clock.now();
    const viewer = await this.getViewer(userId);

    const [user] = await this.db
      .select({ email: schema.users.email, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) throw ApiException.notFound('user', userId);

    const access = this.tokens.issueAccessToken({
      userId,
      email: user.email,
      role: user.role,
      memberships: viewer.businessMemberships.map((membership) => ({
        businessId: membership.businessId,
        role: membership.role,
      })),
    });

    const refreshToken = this.tokens.generateRefreshToken();
    const expiresAt = new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    const [stored] = await this.db
      .insert(schema.refreshTokens)
      .values({
        userId,
        tokenHash: this.crypto.hashToken(refreshToken),
        // A rotated token stays in the family it came from, so reuse anywhere in
        // the chain revokes the whole chain.
        familyId: familyId ?? crypto.randomUUID(),
        expiresAt,
      })
      .returning({ id: schema.refreshTokens.id });

    if (replacedTokenId && stored) {
      await this.db
        .update(schema.refreshTokens)
        .set({ replacedByTokenId: stored.id, revokedAt: now })
        .where(eq(schema.refreshTokens.id, replacedTokenId));
    }

    return {
      tokens: {
        accessToken: access.token,
        expiresIn: access.expiresIn,
        refreshToken,
      },
      viewer,
      isNewUser,
    };
  }
}
