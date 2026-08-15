import { describe, expect, it } from 'vitest';
import { buildTitle } from './notification.service.js';

/**
 * Le titre d'un rappel doit être vrai.
 *
 * Ces cas existent parce que la première version ne l'était pas : le titre était
 * déduit du nom de la fenêtre (« 24 h » → « Demain »), alors que cette fenêtre
 * commence deux heures avant la séance et attrape donc aussi des séances du jour
 * même. Un utilisateur a reçu « Demain : Pilates » pour un cours le soir même.
 *
 * Rien de tout cela n'échoue bruyamment : le rappel part, la base est cohérente,
 * les tests d'intégration passent. C'est simplement faux, et seul un test qui
 * regarde le texte le voit.
 */
describe('titre du rappel', () => {
  it('dit « Aujourd’hui » pour une séance du jour, même dans la fenêtre longue', () => {
    expect(buildTitle('day', true, 'Pilates')).toBe("Aujourd'hui : Pilates");
  });

  it('dit « Demain » seulement quand c’est réellement demain', () => {
    expect(buildTitle('day', false, 'Pilates')).toBe('Demain : Pilates');
  });

  it('parle en heures pour le rappel court, quel que soit le jour', () => {
    // À deux heures du début, le jour n'apporte rien : la personne doit partir.
    expect(buildTitle('hours', true, 'Pilates')).toBe('Dans 2 h : Pilates');
    expect(buildTitle('hours', false, 'Pilates')).toBe('Dans 2 h : Pilates');
  });
});
