import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './index.js';

const validLocal = {
  DATABASE_URL: 'postgres://localhost:5432/try',
  JWT_SECRET: 'a'.repeat(32),
  CHECKIN_TOKEN_SECRET: 'b'.repeat(32),
};

describe('configuration', () => {
  it('applies Brussels-appropriate defaults locally', () => {
    const config = loadConfig(validLocal);
    expect(config.APP_ENV).toBe('local');
    expect(config.PORT).toBe(3000);
    expect(config.isLocal).toBe(true);
    expect(config.isProduction).toBe(false);
  });

  it('fails fast when a required secret is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(ConfigurationError);
  });

  it('rejects a short signing secret', () => {
    expect(() => loadConfig({ ...validLocal, JWT_SECRET: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('parses the CORS allowlist into trimmed origins', () => {
    const config = loadConfig({
      ...validLocal,
      CORS_ALLOWED_ORIGINS: 'https://app.try.be, https://business.try.be',
    });
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(['https://app.try.be', 'https://business.try.be']);
  });

  it('refuses wildcard CORS in production', () => {
    expect(() =>
      loadConfig({
        ...validLocal,
        APP_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
        STRIPE_SECRET_KEY: 'sk_live_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        CORS_ALLOWED_ORIGINS: '*',
      }),
    ).toThrow(/Wildcard CORS/);
  });

  it('refuses to start production without Redis or Stripe', () => {
    expect(() => loadConfig({ ...validLocal, APP_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('refuses to leak OTP codes outside local development', () => {
    expect(() =>
      loadConfig({
        ...validLocal,
        APP_ENV: 'staging',
        REDIS_URL: 'redis://localhost:6379',
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        AUTH_DEV_ECHO_OTP: 'true',
      }),
    ).toThrow(/AUTH_DEV_ECHO_OTP/);
  });

  it('refuses production without a real email transport', () => {
    // The console fallback would write login codes into the logs.
    expect(() =>
      loadConfig({
        ...validLocal,
        APP_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
        STRIPE_SECRET_KEY: 'sk_live_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        CORS_ALLOWED_ORIGINS: 'https://app.try.be',
      }),
    ).toThrow(/RESEND_API_KEY/);
  });

  it('accepts a fully configured production environment', () => {
    const config = loadConfig({
      ...validLocal,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      RESEND_API_KEY: 're_x',
      CORS_ALLOWED_ORIGINS: 'https://app.try.be',
      API_PUBLIC_URL: 'https://api.try.be',
    });
    expect(config.isProduction).toBe(true);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
  });
});
