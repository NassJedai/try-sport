import { describe, expect, it } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { InvalidModerationTransitionError } from '@try/contracts';
import type { Logger } from '@try/logger';
import { ApiExceptionFilter } from './exception.filter.js';

/**
 * Le 500 à tuer : `InvalidModerationTransitionError` n'est ni une
 * `ApiException`, ni une `HttpException`, ni une `ZodError`. Avant la branche
 * ajoutée dans `exception.filter.ts`, elle tombait dans le générique et un
 * gérant qui double-soumettait un lieu voyait « Une erreur est survenue » —
 * une 500 — là où « Actualise et réessaie » (409 CONFLICT) est le message
 * correct.
 *
 * Test unitaire, pas d'intégration : la traduction erreur → réponse HTTP est
 * une responsabilité du filtre seul, sans base de données.
 */
describe('ApiExceptionFilter', () => {
  function silentLogger(): Logger {
    const noop = (): void => undefined;
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
    return { ...logger, child: () => logger } as unknown as Logger;
  }

  function fakeHost(): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      status(code: number) {
        sent.status = code;
        return {
          send(body: unknown) {
            sent.body = body;
          },
        };
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => reply }),
    } as unknown as ArgumentsHost;
    return { host, sent };
  }

  it('mappe une transition de modération invalide sur 409 CONFLICT, jamais sur 500', () => {
    const filter = new ApiExceptionFilter(silentLogger());
    const { host, sent } = fakeHost();

    filter.catch(
      new InvalidModerationTransitionError('venue', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 'BUSINESS'),
      host,
    );

    expect(sent.status).toBe(409);
    expect((sent.body as { code: string }).code).toBe('CONFLICT');
    expect((sent.body as { message: string }).message).not.toMatch(/erreur est survenue/i);
  });

  it('la même erreur sur une offre est mappée de la même façon', () => {
    const filter = new ApiExceptionFilter(silentLogger());
    const { host, sent } = fakeHost();

    filter.catch(
      new InvalidModerationTransitionError('offer', 'DRAFT', 'ACTIVE', 'BUSINESS'),
      host,
    );

    expect(sent.status).toBe(409);
    expect((sent.body as { code: string }).code).toBe('CONFLICT');
  });

  it('une erreur vraiment inattendue reste une 500 générique (comportement inchangé)', () => {
    const filter = new ApiExceptionFilter(silentLogger());
    const { host, sent } = fakeHost();

    filter.catch(new Error('boom, unrelated bug'), host);

    expect(sent.status).toBe(500);
    expect((sent.body as { code: string }).code).toBe('INTERNAL_ERROR');
  });
});
