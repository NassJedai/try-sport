import { z } from 'zod';

/**
 * Configuration is validated once, at startup, and the process refuses to boot if
 * anything required is missing or malformed.
 *
 * The alternative — reading `process.env.FOO!` at the call site — turns a missing
 * secret into a 500 at 3am on the booking endpoint instead of a failed deploy.
 */

const booleanFromString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const APP_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const baseSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS).default('local'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public origin of the API, used to build absolute links in emails. */
  API_PUBLIC_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: booleanFromString.default(false),

  /** Optional in local development; required in staging and production (see refine). */
  REDIS_URL: z.string().optional(),

  /**
   * Signing key for access tokens. Minimum length is enforced because a short
   * HMAC secret is brute-forceable, and this one guards every authenticated call.
   */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),

  /** Separate, longer-lived secret for QR check-in tokens. */
  CHECKIN_TOKEN_SECRET: z.string().min(32, 'CHECKIN_TOKEN_SECRET must be at least 32 characters'),

  CORS_ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3001,http://localhost:3002')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  STORAGE_PUBLIC_BASE_URL: z.url().default('http://localhost:3000/static'),
  STORAGE_BUCKET: z.string().default('try-media'),

  EMAIL_FROM: z.string().default('TRY <hello@try.local>'),
  RESEND_API_KEY: z.string().optional(),

  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.url().default('https://eu.i.posthog.com'),
  SENTRY_DSN: z.string().optional(),

  RATE_LIMIT_ENABLED: booleanFromString.default(true),
  /** Printing OTPs to the log is a development affordance and must never ship. */
  AUTH_DEV_ECHO_OTP: booleanFromString.default(false),
});

export type AppConfig = z.infer<typeof baseSchema> & {
  isProduction: boolean;
  isLocal: boolean;
};

/**
 * Production has stricter requirements than local development. Expressing them as
 * a refinement keeps a single schema instead of two that drift.
 */
const configSchema = baseSchema.superRefine((config, ctx) => {
  const requiresHardening = config.APP_ENV === 'production' || config.APP_ENV === 'staging';
  if (!requiresHardening) return;

  if (!config.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required outside local development (rate limiting and caching).',
    });
  }
  if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['STRIPE_SECRET_KEY'],
      message: 'Stripe credentials are required to take payments in staging and production.',
    });
  }
  if (!config.RESEND_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_API_KEY'],
      message:
        'A real email transport is required outside local development: the console ' +
        'fallback would write login codes into the logs instead of sending them.',
    });
  }
  if (config.AUTH_DEV_ECHO_OTP) {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_DEV_ECHO_OTP'],
      message: 'AUTH_DEV_ECHO_OTP must never be enabled outside local development.',
    });
  }
  if (config.CORS_ALLOWED_ORIGINS.some((origin) => origin === '*')) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ALLOWED_ORIGINS'],
      message: 'Wildcard CORS is not permitted for authenticated endpoints.',
    });
  }
});

export class ConfigurationError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigurationError(`Invalid configuration:\n${details}`);
  }

  return {
    ...result.data,
    isProduction: result.data.APP_ENV === 'production',
    isLocal: result.data.APP_ENV === 'local',
  };
}
