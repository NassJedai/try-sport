/**
 * Serialises the tokens to CSS custom properties for the two Next.js dashboards.
 *
 * This exists so the web side stops being a hand-kept copy of `index.ts`. The
 * output is written to `tokens.css` by `scripts/generate-css.mjs` and imported
 * by each app's `globals.css`; `tokens.test.ts` fails if the committed file has
 * drifted from what this function produces.
 *
 * Tailwind v4 reads the `@theme` block, so `bg-surface` on the web and
 * `theme.surface` in React Native resolve to the same colour by construction
 * rather than by discipline.
 */
import { darkTheme, focusRing, lightTheme, palette, radius, type Theme } from './index.js';

/** Semantic token name → CSS custom property name. */
const CSS_VARIABLE_BY_TOKEN: Record<keyof Theme, string> = {
  background: '--color-background',
  backgroundElevated: '--color-background-elevated',
  backgroundSunken: '--color-background-sunken',
  surface: '--color-surface',
  surfaceMuted: '--color-surface-muted',

  textPrimary: '--color-text-primary',
  textSecondary: '--color-text-secondary',
  textTertiary: '--color-text-tertiary',
  textInverse: '--color-text-inverse',

  border: '--color-border',
  borderStrong: '--color-border-strong',

  accent: '--color-accent',
  accentPressed: '--color-accent-pressed',
  accentSubtle: '--color-accent-subtle',
  onAccent: '--color-on-accent',
  accentText: '--color-accent-text',

  price: '--color-price',
  priceSubtle: '--color-price-subtle',
  priceSurface: '--color-price-surface',
  onPrice: '--color-on-price',

  success: '--color-success',
  successSubtle: '--color-success-subtle',
  successSurface: '--color-success-surface',
  onSuccess: '--color-on-success',
  warning: '--color-warning',
  warningSubtle: '--color-warning-subtle',
  warningSurface: '--color-warning-surface',
  onWarning: '--color-on-warning',
  danger: '--color-danger',
  dangerSubtle: '--color-danger-subtle',
  dangerSurface: '--color-danger-surface',
  onDanger: '--color-on-danger',

  focusRing: '--color-focus-ring',
  focusRingInverse: '--color-focus-ring-inverse',

  skeleton: '--color-skeleton',
  overlay: '--color-overlay',
};

/**
 * Typed as a total map of the ramp rather than a hand-kept list: adding an
 * `ink150` to the palette then becomes a compile error here instead of a step
 * that silently never reaches the web.
 */
type RampStep = Extract<keyof typeof palette, `ink${string}`>;

const RAMP_STEPS: Record<RampStep, string> = {
  ink950: palette.ink950,
  ink900: palette.ink900,
  ink800: palette.ink800,
  ink700: palette.ink700,
  ink600: palette.ink600,
  ink500: palette.ink500,
  ink400: palette.ink400,
  ink300: palette.ink300,
  ink200: palette.ink200,
  ink100: palette.ink100,
  ink50: palette.ink50,
};

function themeBlock(theme: Theme, indent: string): string {
  return (Object.keys(CSS_VARIABLE_BY_TOKEN) as (keyof Theme)[])
    .map((token) => `${indent}${CSS_VARIABLE_BY_TOKEN[token]}: ${theme[token]};`)
    .join('\n');
}

export function renderTokensCss(): string {
  const ramp = Object.entries(RAMP_STEPS)
    .map(([name, value]) => `  --color-${name.replace(/(\d+)$/, '-$1')}: ${value};`)
    .join('\n');

  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced from packages/design-tokens/src/index.ts by
 * \`pnpm --filter @try/design-tokens build\`. Edit the tokens there; this file is
 * regenerated, and tokens.test.ts fails if the two drift apart.
 */

/**
 * \`static\` because Tailwind otherwise drops any theme variable no utility
 * happens to reference. The dark block below is plain CSS and is emitted whole,
 * so pruning produced a palette that was complete in dark and full of holes in
 * light — \`--color-price\` resolved to nothing until a \`text-price\` appeared
 * somewhere. Anything read through a bare \`var()\` (inline style, CSS module)
 * needs both halves present.
 */
@theme static {
${ramp}
  --color-white: ${palette.white};

${themeBlock(lightTheme, '  ')}

  --radius-card: ${radius.lg}px;
  --radius-pill: ${radius.pill}px;

  --focus-ring-width: ${focusRing.width}px;
  --focus-ring-offset: ${focusRing.offset}px;
}

/**
 * Dark theme, opt-in.
 *
 * Deliberately keyed on an attribute rather than \`prefers-color-scheme\`: the
 * dashboards have not been audited against a dark surface set, and flipping
 * them automatically would drop white inputs onto a dark page. An app opts in
 * by setting \`data-theme="dark"\` once its screens are ready.
 */
[data-theme='dark'] {
${themeBlock(darkTheme, '  ')}
}
`;
}
