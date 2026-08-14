import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { AppConfig } from '@try/config';
import { CONFIG } from '../config.module.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, for the Retry-After header. */
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
}

/**
 * Named limits, tuned to what each endpoint costs and what abusing it achieves.
 * OTP is the strictest: it sends email and is the entry point for account takeover.
 */
export const RATE_LIMITS = {
  otpRequest: { limit: 5, windowSeconds: 900 },
  otpVerify: { limit: 10, windowSeconds: 900 },
  signup: { limit: 10, windowSeconds: 3600 },
  search: { limit: 120, windowSeconds: 60 },
  booking: { limit: 20, windowSeconds: 300 },
  payment: { limit: 20, windowSeconds: 300 },
  review: { limit: 10, windowSeconds: 3600 },
  referral: { limit: 30, windowSeconds: 3600 },
  checkIn: { limit: 300, windowSeconds: 60 },
  default: { limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

interface RateLimitStore {
  increment(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
  close(): Promise<void>;
}

/**
 * Redis-backed counter. INCR + EXPIRE in a pipeline is a fixed-window limiter:
 * it permits a burst at a window edge, which is an acceptable trade for the cost
 * of a sliding-window implementation at this stage. It is shared across API
 * instances, which is the property that actually matters.
 */
class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const results = await this.redis
      .multi()
      .incr(key)
      // NX so an in-flight window is not extended by later requests.
      .expire(key, windowSeconds, 'NX')
      .ttl(key)
      .exec();

    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * In-memory fallback for local development, where running Redis is friction that
 * discourages people from running the API at all. Production configuration
 * requires REDIS_URL, so this can never be silently relied on in a cluster.
 */
class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  increment(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }> {
    const now = Date.now();
    const existing = this.counters.get(key);

    if (!existing || existing.expiresAt <= now) {
      const expiresAt = now + windowSeconds * 1000;
      this.counters.set(key, { count: 1, expiresAt });
      this.sweep(now);
      return Promise.resolve({ count: 1, ttlSeconds: windowSeconds });
    }

    existing.count += 1;
    return Promise.resolve({
      count: existing.count,
      ttlSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
    });
  }

  /** Bounded cleanup so a long-running dev server does not grow without limit. */
  private sweep(now: number): void {
    if (this.counters.size < 10_000) return;
    for (const [key, value] of this.counters) {
      if (value.expiresAt <= now) this.counters.delete(key);
    }
  }

  close(): Promise<void> {
    this.counters.clear();
    return Promise.resolve();
  }
}

@Injectable()
export class RateLimiter implements OnApplicationShutdown {
  private readonly store: RateLimitStore;
  private readonly enabled: boolean;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.enabled = config.RATE_LIMIT_ENABLED;
    this.store = config.REDIS_URL
      ? new RedisRateLimitStore(
          new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }),
        )
      : new MemoryRateLimitStore();
  }

  async consume(
    name: RateLimitName,
    /** Identity being limited: user id when known, otherwise client IP. */
    identifier: string,
  ): Promise<RateLimitResult> {
    if (!this.enabled) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
    }

    const rule = RATE_LIMITS[name];
    const { count, ttlSeconds } = await this.store.increment(
      `ratelimit:${name}:${identifier}`,
      rule.windowSeconds,
    );

    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      retryAfterSeconds: ttlSeconds,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.store.close();
  }
}
