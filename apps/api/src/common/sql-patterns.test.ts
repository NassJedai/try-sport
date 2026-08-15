import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde contre un piège du driver, pas contre une faute de goût.
 *
 * `sql\`col = ANY(${tableauJs}::type[])\`` compile, typecheck, et explose à la
 * première exécution : le template sql de Drizzle déplie un tableau JS en tuple
 * « ($1, $2) », que Postgres refuse de caster en tableau (« cannot cast type
 * record »), et un tableau d'un seul élément devient un littéral malformé.
 *
 * Le motif s'était propagé par copier-coller dans NEUF endroits — filtres de
 * recherche côté client, annulation de créneau, job des no-shows — tous des
 * chemins qui ne s'exécutent qu'avec de vraies données, donc tous verts en CI.
 * Découvert quand la première annulation réelle d'un créneau a rendu une 500.
 *
 * Les formes qui marchent : `inArray(colonne, tableau)` en contexte schéma,
 * `IN ${tableau}` en SQL brut (le tuple est exactement ce que IN attend).
 */
describe('motifs SQL interdits', () => {
  it("n'utilise jamais = ANY(${...}) dans un fragment sql", () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;

        const source = readFileSync(path, 'utf8');
        // La forme fautive interpole directement dans ANY( ... ) ; les usages
        // légitimes de ANY sur une sous-requête SQL n'interpolent pas de `${`.
        if (/ANY\(\s*\$\{/.test(source)) offenders.push(path);
      }
    };

    walk(join(import.meta.dirname, '..'));

    expect(offenders).toEqual([]);
  });
});
