import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ERROR_MESSAGES_FR,
  InvalidModerationTransitionError,
  InvalidReservationTransitionError,
} from '@try/contracts';
import type { ApiErrorBody, ErrorCode } from '@try/contracts';
import { getRequestId } from '@try/logger';
import type { Logger } from '@try/logger';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { ApiException } from './api-exception.js';
import { LOGGER } from '../logger.module.js';

/**
 * Turns every failure into the same shaped body.
 *
 * Two rules drive this filter:
 *   1. A user never sees a stack trace, a SQL error or the string
 *      "Internal Server Error" — they see what happened and what to do next.
 *   2. Every response carries the request id, so a screenshot from a user maps
 *      directly onto a log line.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const requestId = getRequestId() ?? 'unknown';

    const { status, body, logLevel, internal } = this.describe(exception, requestId);

    this.logger[logLevel](
      {
        err: exception instanceof Error ? exception : new Error(String(exception)),
        status,
        code: body.code,
        ...internal,
      },
      body.code === 'INTERNAL_ERROR' ? 'Unhandled error' : 'Request failed',
    );

    void reply.status(status).send(body);
  }

  private describe(
    exception: unknown,
    requestId: string,
  ): {
    status: number;
    body: ApiErrorBody;
    logLevel: 'warn' | 'error';
    internal?: Record<string, unknown>;
  } {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        body: {
          code: exception.code,
          message: exception.message,
          requestId,
          ...(exception.details ? { details: exception.details } : {}),
        },
        // Expected domain conflicts are not server faults; only 5xx is an error.
        logLevel: exception.getStatus() >= 500 ? 'error' : 'warn',
        internal: exception.context,
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: 'VALIDATION_FAILED',
          message: ERROR_MESSAGES_FR.VALIDATION_FAILED,
          requestId,
          details: formatZodIssues(exception),
        },
        logLevel: 'warn',
      };
    }

    // Une transition de modération illégale (double soumission, retrait d'un
    // lieu déjà actif…) est un conflit métier, pas une panne : sans cette
    // branche l'erreur tombe dans le générique ci-dessous et un gérant qui
    // double-clique sur « soumettre » voit une 500 « Une erreur est
    // survenue » là où « Actualise et réessaie » est le message correct.
    if (exception instanceof InvalidModerationTransitionError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { code: 'CONFLICT', message: ERROR_MESSAGES_FR.CONFLICT, requestId },
        logLevel: 'warn',
      };
    }

    /**
     * Même défaut que ci-dessus, côté réservations : `assertTransition` lève
     * `InvalidReservationTransitionError` (annulation d'une réservation déjà
     * annulée, no-show marqué deux fois…), et rien ne la convertissait avant
     * cette branche. `INVALID_STATE_TRANSITION` existe dans le catalogue
     * depuis le début (`errors.ts`) mais n'était jamais atteint : toute
     * transition refusée par la machine à états tombait dans le générique
     * 500 ci-dessous, alors que 409 est la réponse correcte.
     */
    if (exception instanceof InvalidReservationTransitionError) {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          code: 'INVALID_STATE_TRANSITION',
          message: ERROR_MESSAGES_FR.INVALID_STATE_TRANSITION,
          requestId,
        },
        logLevel: 'warn',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 429
                ? 'RATE_LIMITED'
                : status >= 500
                  ? 'INTERNAL_ERROR'
                  : 'VALIDATION_FAILED';

      return {
        status,
        // Nest's default messages ("Cannot POST /x") are not user-facing copy.
        body: { code, message: ERROR_MESSAGES_FR[code], requestId },
        logLevel: status >= 500 ? 'error' : 'warn',
      };
    }

    // Anything unrecognised is a bug: log it fully, tell the user nothing about it.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: ERROR_MESSAGES_FR.INTERNAL_ERROR,
        requestId,
      },
      logLevel: 'error',
    };
  }
}

export function formatZodIssues(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '(root)';
    (details[path] ??= []).push(issue.message);
  }
  return details;
}
