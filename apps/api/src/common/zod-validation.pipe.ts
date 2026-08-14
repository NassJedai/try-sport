import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import { ApiException } from './errors/api-exception.js';
import { formatZodIssues } from './errors/exception.filter.js';

/**
 * Validates and *replaces* the incoming payload with the parsed result, so
 * handlers receive coerced, defaulted, trusted data rather than raw JSON.
 *
 * Applied per-parameter rather than globally: query, params and body have
 * different schemas, and a global pipe cannot know which is which.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ApiException('VALIDATION_FAILED', undefined, formatZodIssues(error));
      }
      throw error;
    }
  }
}

/** `@Body(zodBody(createBookingSchema))` reads better than constructing the pipe inline. */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

export function zodQuery<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
