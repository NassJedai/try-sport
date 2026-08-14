import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithRequestContext } from '@try/logger';
import type { Logger } from '@try/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LOGGER } from './logger.module.js';

/**
 * Assigns every request an id, echoes it back, and logs one structured line per
 * completed request.
 *
 * An inbound `x-request-id` is honoured so a trace started at the CDN or in the
 * mobile client stays a single trace, but it is length-capped: header values are
 * attacker-controlled and end up in log storage.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(request: FastifyRequest['raw'], response: FastifyReply['raw'], next: () => void): void {
    const inbound = request.headers['x-request-id'];
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 64
        ? inbound
        : randomUUID();

    response.setHeader('x-request-id', requestId);

    const startedAt = process.hrtime.bigint();
    const route = `${request.method} ${request.url ?? ''}`;

    runWithRequestContext({ requestId, route }, () => {
      response.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const status = response.statusCode;
        // 4xx is the client's problem, 5xx is ours; log levels reflect that.
        const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

        this.logger[level](
          {
            method: request.method,
            url: request.url,
            status,
            durationMs: Math.round(durationMs * 100) / 100,
          },
          'request completed',
        );
      });

      next();
    });
  }
}
