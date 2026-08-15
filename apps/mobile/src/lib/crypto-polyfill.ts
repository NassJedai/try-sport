import * as Crypto from 'expo-crypto';

/**
 * Hermes n'expose pas `crypto.getRandomValues`. Notre générateur d'aléa (clés
 * d'idempotence de réservation, jetons) refuse — à raison — de se rabattre sur
 * `Math.random` : il exige une source cryptographique et lève sinon. Sans ce
 * polyfill, ouvrir un détail d'offre était un écran blanc.
 *
 * expo-crypto fournit la vraie source native ; on ne fait que la brancher là où
 * le standard Web la promet. Jamais de repli silencieux vers du pseudo-aléa.
 */
const globalScope = globalThis as { crypto?: { getRandomValues?: unknown } };

if (typeof globalScope.crypto?.getRandomValues !== 'function') {
  globalScope.crypto = {
    ...globalScope.crypto,
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
      Crypto.getRandomValues(array as never) as T,
  };
}
