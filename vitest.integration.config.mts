import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

/**
 * Integration tests that require a real Postgres with PostGIS.
 *
 * Kept in a separate config so `pnpm test` stays fast and hermetic.
 *
 * TROIS DÉFAUTS SUCCESSIFS ONT ÉTÉ CORRIGÉS ICI, ET L'ORDRE COMPTE.
 *
 * 1. Le skip silencieux. Vitest ne charge pas `.env` dans `process.env` :
 *    `pnpm test:integration` sautait la totalité de la suite et sortait en
 *    code 0 sur une machine pourtant correctement configurée. Un relecteur
 *    s'y est fait prendre et a conclu qu'un lot touchant à l'argent n'avait
 *    aucune couverture, alors qu'il en avait. Corrigé le 22 août : `.env` est
 *    lu explicitement ci-dessous.
 *
 * 2. La cible par défaut. Ce correctif-là a fait viser `DATABASE_URL` — la
 *    base de DÉMONSTRATION — à une suite qui sème et détruit des données.
 *    Constaté le 27 août : 144 lieux au lieu de 20, dont 116 « Test Venue »
 *    dans la base que le fondateur utilise pour regarder son produit.
 *
 * 3. D'où la garde ci-dessous. Le repli ne prend plus `DATABASE_URL` : il en
 *    DÉRIVE un nom de base distinct en suffixant `_test`. Et si la base
 *    résolue est malgré tout celle de développement, la suite REFUSE de
 *    démarrer plutôt que d'écrire dedans.
 *
 * La leçon des trois : une consigne qu'on peut oublier n'est pas une
 * protection. Le seul garde-fou qui tient est celui qui rend la faute
 * impossible, pas celui qui la déconseille.
 *
 * L'ordre de résolution laisse toujours le dernier mot à l'appelant : une
 * variable posée sur la ligne de commande gagne sur `.env`.
 */
const dotenv = loadEnv('test', process.cwd(), '');

const devDatabaseUrl = process.env.DATABASE_URL ?? dotenv.DATABASE_URL;
const explicit = process.env.TEST_DATABASE_URL ?? dotenv.TEST_DATABASE_URL;

/** `postgres://…/try_dev` → `postgres://…/try_dev_test`. */
function deriveTestDatabaseUrl(url: string): string {
  return url.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
}

const databaseUrl = explicit ?? (devDatabaseUrl ? deriveTestDatabaseUrl(devDatabaseUrl) : undefined);

if (databaseUrl && devDatabaseUrl && databaseUrl === devDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL pointe sur la base de developpement (DATABASE_URL).\n" +
      "Cette suite seme et detruit des donnees : elle refuse d'ecrire dans la base\n" +
      "de demonstration. Pose TEST_DATABASE_URL sur une base dediee, par exemple\n" +
      `  ${deriveTestDatabaseUrl(devDatabaseUrl)}\n` +
      'et cree-la si besoin (createdb + pnpm db:migrate).',
  );
}

export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    env: {
      ...(databaseUrl ? { TEST_DATABASE_URL: databaseUrl } : {}),
      // Mêmes raisons que la base : vitest ne charge pas `.env` dans
      // process.env, donc sans ce passe-plat les suites qui touchent Stripe se
      // sautent en silence. Constaté le 27 août sur le premier test de
      // paiement de bout en bout — écrit, vert en apparence, jamais exécuté.
      // « skipped » n'est pas « passed », troisième rappel.
      ...(process.env.STRIPE_SECRET_KEY ?? dotenv.STRIPE_SECRET_KEY
        ? { STRIPE_SECRET_KEY: (process.env.STRIPE_SECRET_KEY ?? dotenv.STRIPE_SECRET_KEY)! }
        : {}),
      ...(process.env.STRIPE_WEBHOOK_SECRET ?? dotenv.STRIPE_WEBHOOK_SECRET
        ? {
            STRIPE_WEBHOOK_SECRET: (process.env.STRIPE_WEBHOOK_SECRET ??
              dotenv.STRIPE_WEBHOOK_SECRET)!,
          }
        : {}),
    },
    // Booking concurrency tests contend on the same rows on purpose.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
