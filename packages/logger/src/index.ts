import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/**
 * Fields that must never reach a log sink, at any nesting depth.
 *
 * Redaction is centralised here rather than left to each call site, because the
 * one place someone forgets is the place that logs a raw request body containing
 * a card token or an auth header.
 */
const REDACTED_PATHS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  // La preuve d'identité renvoyée par Google ou Apple, telle que nommée par
  // `oauthLoginSchema`. Masquée avant que l'endpoint existe : le jour où il
  // journalise un corps de requête, l'oubli ne se voit pas — il se lit dans
  // les logs.
  'credential',
  'clientSecret',
  'code',
  'codeHash',
  'qrToken',
  'authorization',
  'cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.credential',
  '*.clientSecret',
  '*.cardNumber',
  '*.cvc',
];

export interface RequestContext {
  requestId: string;
  /** Present only for authenticated calls. */
  userId?: string;
  businessId?: string;
  route?: string;
}

/**
 * Request context propagated without threading a logger through every function
 * signature. Background jobs inherit the request id of whatever enqueued them, so
 * a booking can be traced from the HTTP call through to the confirmation email.
 */
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

export interface CreateLoggerOptions {
  level?: string;
  /** Human-readable output locally; single-line JSON everywhere else. */
  pretty?: boolean;
  service?: string;
  release?: string;
  environment?: string;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const {
    level = 'info',
    pretty = false,
    service = 'try-api',
    release = process.env.RELEASE_SHA ?? 'dev',
    environment = process.env.APP_ENV ?? 'local',
  } = options;

  return pino({
    level,
    base: { service, release, environment },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    // Every log line carries the request id, so a user's error report maps to a trace.
    mixin() {
      const context = requestContextStorage.getStore();
      return context ? { requestId: context.requestId, userId: context.userId } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  });
}

export { REDACTED_PATHS };
