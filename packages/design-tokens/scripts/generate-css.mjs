/**
 * Writes tokens.css from the compiled tokens.
 *
 * Runs as the tail of `pnpm --filter @try/design-tokens build`, so the file the
 * dashboards import can never be edited into disagreement with index.ts —
 * tokens.test.ts fails the moment it is.
 */
import { writeFileSync } from 'node:fs';
import { renderTokensCss } from '../dist/css.js';

const target = new URL('../tokens.css', import.meta.url);
writeFileSync(target, renderTokensCss(), 'utf8');
console.log(`design-tokens: wrote ${target.pathname.split('/').slice(-1)[0]}`);
