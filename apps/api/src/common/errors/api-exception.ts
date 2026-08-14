import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, ERROR_MESSAGES_FR } from '@try/contracts';
import type { ErrorCode } from '@try/contracts';

/**
 * The only exception type the domain throws.
 *
 * Carrying the machine-readable code means the HTTP status and the user-facing
 * message are derived in one place instead of being chosen ad hoc per controller,
 * and clients can branch on `code` without parsing prose.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    /** Overrides the default French copy when a more specific message helps. */
    message?: string,
    readonly details?: Record<string, string[]>,
    /** Internal-only context for logs; never serialised to the client. */
    readonly context?: Record<string, unknown>,
  ) {
    super(message ?? ERROR_MESSAGES_FR[code], ERROR_HTTP_STATUS[code]);
    this.name = 'ApiException';
  }

  static notFound(entity: string, id?: string): ApiException {
    return new ApiException('NOT_FOUND', undefined, undefined, { entity, id });
  }

  static forbidden(reason: string): ApiException {
    return new ApiException('FORBIDDEN', undefined, undefined, { reason });
  }

  static conflict(code: ErrorCode, context?: Record<string, unknown>): ApiException {
    return new ApiException(code, undefined, undefined, context);
  }
}
