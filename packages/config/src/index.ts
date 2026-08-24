import { networkInterfaces } from 'node:os';
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
  /**
   * Origine publique du tableau de bord des salles. Sert à construire le lien
   * direct vers l'écran de complétion/correction dans les e-mails envoyés aux
   * gérants (décision de modération, relance J+1/J+3) — un lien relatif n'a
   * pas de sens dans un e-mail, qui n'a pas d'origine.
   */
  BUSINESS_PUBLIC_URL: z.url().default('http://localhost:3001'),
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

  /**
   * URL publique utilisée pour composer le lien d'une image (voir
   * `MediaService.publicUrl`). Une valeur explicite garde toujours la
   * priorité et est obligatoire en préproduction/production (voir le
   * `superRefine` plus bas) : c'est là qu'elle pointe vers un CDN, et deviner
   * une adresse de CDN serait dangereux.
   *
   * En son absence — en local uniquement, la valeur restant requise ailleurs
   * — `loadConfig` la dérive de l'adresse réseau réellement utilisée par
   * cette machine. C'est le pendant serveur de `resolveApiUrl()` dans
   * `apps/mobile/src/api/client.ts:50-71` : l'app mobile déduit l'adresse de
   * l'API depuis l'hôte Expo parce que « localhost » ne veut rien dire depuis
   * un téléphone ; ici, l'API déduit sa propre adresse pour la même raison,
   * côté image plutôt que côté API. Un `.env` avec une IP figée casse dès que
   * la box redistribue les adresses — exactement le bug que cette dérivation
   * évite.
   */
  STORAGE_PUBLIC_BASE_URL: z.url().optional(),
  STORAGE_BUCKET: z.string().default('try-media'),
  /**
   * Où les fichiers uploadés vivent en local. En production, un stockage objet
   * remplace le disque derrière la même frontière (MediaService) et
   * STORAGE_PUBLIC_BASE_URL pointe vers le CDN.
   */
  MEDIA_DIR: z.string().default('.media'),

  EMAIL_FROM: z.string().default('TRIALYA <hello@try.local>'),
  RESEND_API_KEY: z.string().optional(),

  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.url().default('https://eu.i.posthog.com'),
  SENTRY_DSN: z.string().optional(),

  RATE_LIMIT_ENABLED: booleanFromString.default(true),
  /** Printing OTPs to the log is a development affordance and must never ship. */
  AUTH_DEV_ECHO_OTP: booleanFromString.default(false),
});

export type AppConfig = Omit<z.infer<typeof baseSchema>, 'STORAGE_PUBLIC_BASE_URL'> & {
  /** Toujours résolue : dérivée en local si absente de l'environnement, voir `loadConfig`. */
  STORAGE_PUBLIC_BASE_URL: string;
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
  if (!config.STORAGE_PUBLIC_BASE_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['STORAGE_PUBLIC_BASE_URL'],
      message:
        'STORAGE_PUBLIC_BASE_URL is required outside local development: it must point at ' +
        'the CDN explicitly, never be guessed from a network interface.',
    });
  }
});

export class ConfigurationError extends Error {}

/**
 * Devine l'adresse à laquelle cette machine est joignable sur le réseau
 * local — le pendant serveur de `resolveApiUrl()` dans
 * `apps/mobile/src/api/client.ts:50-71`. Là-bas, l'app mobile déduit
 * l'adresse de l'API depuis l'hôte Expo parce que « localhost » depuis un
 * téléphone pointe vers le téléphone lui-même ; ici, c'est le même problème
 * pour les URLs d'image que l'API renvoie à ce téléphone.
 *
 * Best-effort : première interface IPv4 non interne trouvée. Une machine
 * avec plusieurs interfaces actives (VPN, réseau partagé…) peut en avoir
 * plusieurs — rien ici ne sait laquelle est « la bonne » pour joindre un
 * téléphone sur le même Wi-Fi. Sans interface externe (CI, conteneur sans
 * réseau hôte), retombe sur `localhost` : ça ne sert plus un téléphone, mais
 * ça ne bloque pas non plus un démarrage local sans réseau.
 */
function guessLanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

function deriveStoragePublicBaseUrl(port: number): string {
  return `http://${guessLanAddress()}:${port}/media`;
}

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
    // Garanti non vide ici : le superRefine ci-dessus rend la valeur
    // obligatoire hors développement local, donc `undefined` ne peut
    // survenir que dans le cas où la dérivation est sûre.
    STORAGE_PUBLIC_BASE_URL:
      result.data.STORAGE_PUBLIC_BASE_URL ?? deriveStoragePublicBaseUrl(result.data.PORT),
    isProduction: result.data.APP_ENV === 'production',
    isLocal: result.data.APP_ENV === 'local',
  };
}
