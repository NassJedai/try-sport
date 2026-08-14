import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { REDACTED_PATHS, getRequestId, runWithRequestContext } from './index.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });
  const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[redacted]' } }, stream);
  return { logger, lines };
}

describe('logger redaction', () => {
  it('never writes an auth token or password to the sink', () => {
    const { logger, lines } = captureLogger();
    logger.info({ password: 'hunter2', accessToken: 'eyJhbGciOi', email: 'a@b.test' }, 'login');

    const entry = lines[0];
    expect(entry?.password).toBe('[redacted]');
    expect(entry?.accessToken).toBe('[redacted]');
    // Non-sensitive fields still come through, or the logs would be useless.
    expect(entry?.email).toBe('a@b.test');
  });

  it('redacts nested credentials one level down', () => {
    const { logger, lines } = captureLogger();
    logger.info({ payment: { clientSecret: 'pi_secret', amount: 1000 } }, 'payment');

    const payment = lines[0]?.payment as Record<string, unknown> | undefined;
    expect(payment?.clientSecret).toBe('[redacted]');
    expect(payment?.amount).toBe(1000);
  });

  it('redacts the authorization header', () => {
    const { logger, lines } = captureLogger();
    logger.info({ headers: { authorization: 'Bearer abc', 'x-request-id': 'r1' } }, 'request');

    const headers = lines[0]?.headers as Record<string, unknown> | undefined;
    expect(headers?.authorization).toBe('[redacted]');
    expect(headers?.['x-request-id']).toBe('r1');
  });
});

describe('request context', () => {
  it('propagates the request id through async work', async () => {
    const result = await runWithRequestContext({ requestId: 'req-123', userId: 'u1' }, async () => {
      await Promise.resolve();
      return getRequestId();
    });
    expect(result).toBe('req-123');
  });

  it('is undefined outside a request', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('isolates concurrent requests from each other', async () => {
    const [a, b] = await Promise.all([
      runWithRequestContext({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestId();
      }),
      runWithRequestContext({ requestId: 'b' }, async () => getRequestId()),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
  });
});
