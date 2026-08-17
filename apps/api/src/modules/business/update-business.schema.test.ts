import { describe, expect, it } from 'vitest';
import { ApiException } from '../../common/errors/api-exception.js';
import { zodBody } from '../../common/zod-validation.pipe.js';
import { updateBusinessSchema } from './update-business.schema.js';

/**
 * Test unitaire, pas d'intégration : ce que le pipe de validation fait à un
 * corps de requête, sans base de données. Passe par `zodBody` — le même pipe
 * que `BusinessController.updateBusiness` déclare — pour prouver la forme
 * réelle de la réponse d'erreur (`ApiException.details.vatNumber`), pas
 * seulement le comportement de Zod isolé.
 */
describe('updateBusinessSchema', () => {
  const pipe = zodBody(updateBusinessSchema);

  it('normalise une TVA saisie avec espaces, minuscules et points en forme canonique', () => {
    const dto = pipe.transform({ vatNumber: 'be 0417.497.106' }, {} as never);
    expect(dto.vatNumber).toBe('BE0417497106');
  });

  it('rejette une TVA dont la clé de contrôle est fausse — 400, message dans details.vatNumber', () => {
    let caught: unknown;
    try {
      pipe.transform({ vatNumber: 'BE0123456789' }, {} as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiException);
    const exception = caught as ApiException;
    expect(exception.getStatus()).toBe(400);
    expect(exception.code).toBe('VALIDATION_FAILED');
    expect(exception.details?.vatNumber?.[0]).toMatch(/clé de contrôle/);
  });

  it('accepte contactPhone: null comme remise à zéro explicite', () => {
    const dto = pipe.transform({ contactPhone: null }, {} as never);
    expect(dto.contactPhone).toBeNull();
  });

  it('laisse contactPhone absent quand la clé n’est pas envoyée — "absent" reste distinct de "null"', () => {
    const dto = pipe.transform({}, {} as never);
    expect('contactPhone' in dto).toBe(false);
  });

  it('retire silencieusement les champs hors périmètre (name, commissionBasisPoints, status, billingModel)', () => {
    const dto = pipe.transform(
      {
        name: 'Nouveau nom',
        commissionBasisPoints: 9999,
        status: 'ACTIVE',
        billingModel: 'FLAT_FEE',
        contactEmail: 'contact@try.local',
      },
      {} as never,
    );
    expect(dto).not.toHaveProperty('name');
    expect(dto).not.toHaveProperty('commissionBasisPoints');
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('billingModel');
    expect(dto.contactEmail).toBe('contact@try.local');
  });

  it("accepte countryCode dans la forme (refusé plus loin par le service, pas par ce schéma)", () => {
    const dto = pipe.transform({ countryCode: 'FR' }, {} as never);
    expect(dto.countryCode).toBe('FR');
  });
});
