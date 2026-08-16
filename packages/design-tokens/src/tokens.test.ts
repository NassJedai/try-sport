import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTokensCss } from './css.js';
import { darkTheme, lightTheme, palette, type Theme } from './index.js';

/**
 * Contrast is the one property of this palette that cannot be checked by eye.
 *
 * The acid lime reads as vivid and confident and is, at 0.84 relative
 * luminance, very nearly white to a contrast algorithm. A palette built around
 * it stays accessible only if the sanctioned pairings are asserted, so this
 * suite is the contract: every combination the design system tells a developer
 * to reach for has to clear WCAG 2.1 AA.
 */

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3; // 1.4.11: UI component boundaries and focus indicators.

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. Opaque hex only — see `flatten` for the rest. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const r = channel(parseInt(value.slice(0, 2), 16));
  const g = channel(parseInt(value.slice(2, 4), 16));
  const b = channel(parseInt(value.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Composites an `rgba()` token over an opaque backdrop.
 *
 * The translucent subtle tints are real backgrounds that real text sits on;
 * measuring them against their own alpha channel would be meaningless.
 */
function flatten(colour: string, backdrop: string): string {
  const match = /^rgba?\(([^)]+)\)$/.exec(colour);
  const body = match?.[1];
  if (body === undefined) return colour;

  const parts = body.split(',').map((part) => Number(part.trim()));
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`unparseable colour token: ${colour}`);
  }
  const alpha = parts[3] ?? 1;

  const base = backdrop.replace('#', '');
  const mix = (over: number, index: number) =>
    Math.round(over * alpha + parseInt(base.slice(index, index + 2), 16) * (1 - alpha));
  return `#${[mix(r, 0), mix(g, 2), mix(b, 4)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const THEMES: [string, Theme][] = [
  ['light', lightTheme],
  ['dark', darkTheme],
];

/** Every opaque surface a component is allowed to sit on, per theme. */
function surfaces(theme: Theme): [string, string][] {
  return [
    ['background', theme.background],
    ['backgroundElevated', theme.backgroundElevated],
    ['backgroundSunken', theme.backgroundSunken],
    ['surface', theme.surface],
    ['surfaceMuted', theme.surfaceMuted],
  ];
}

describe.each(THEMES)('%s theme — text', (_name, theme) => {
  const tiers: [string, string][] = [
    ['textPrimary', theme.textPrimary],
    ['textSecondary', theme.textSecondary],
    ['textTertiary', theme.textTertiary],
  ];

  it.each(tiers)('%s clears AA on every neutral surface', (_tier, colour) => {
    for (const [, surface] of surfaces(theme)) {
      expect(contrast(colour, surface)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('borderStrong clears the 3:1 non-text floor on every neutral surface', () => {
    for (const [, surface] of surfaces(theme)) {
      expect(contrast(theme.borderStrong, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe.each(THEMES)('%s theme — accent', (_name, theme) => {
  /**
   * The opaque fills only. `accentSubtle` is a pale wash in the light theme but
   * a translucent tint over a dark page in the dark one, so it is the one
   * accent surface whose text colour flips — it carries `accentText`, asserted
   * below, rather than ink.
   */
  it('onAccent clears AA on the opaque accent fills', () => {
    for (const fill of [theme.accent, theme.accentPressed]) {
      expect(contrast(theme.onAccent, fill)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('accentText clears AA on every surface the accent can be written on', () => {
    const backdrops = [
      ...surfaces(theme).map(([, surface]) => surface),
      flatten(theme.accentSubtle, theme.background),
    ];
    for (const backdrop of backdrops) {
      expect(contrast(theme.accentText, backdrop)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe('the lime is a fill, not a text colour', () => {
  /**
   * Guards the reason `accentText` exists at all. If someone "simplifies" the
   * two accent tokens back into one, this fails and says why.
   */
  it('fails contrast as text on light surfaces, which is why accentText exists', () => {
    expect(contrast(palette.lime500, lightTheme.surface)).toBeLessThan(AA_NON_TEXT);
    expect(contrast(palette.lime500, lightTheme.background)).toBeLessThan(AA_NON_TEXT);
    expect(lightTheme.accentText).not.toBe(lightTheme.accent);
  });

  it('is safe as text on dark surfaces, where it needs no darkened variant', () => {
    expect(contrast(palette.lime500, darkTheme.background)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(darkTheme.accentText).toBe(darkTheme.accent);
  });
});

describe.each(THEMES)('%s theme — status colours', (_name, theme) => {
  /**
   * Status text is sanctioned on `surface`, `background` and its own subtle
   * tint — not on `surfaceMuted` (nor on `backgroundSunken`, which holds the
   * same value in the light theme). `success` and `warning` land at 4.36:1 and
   * 4.28:1 there, a consequence of the page background moving off pure white.
   * Nothing in the codebase does it today; a filled `*Surface` pill is the
   * supported way to put a status on a muted row.
   */
  const pairs: [string, string, string][] = [
    ['success', theme.success, theme.successSubtle],
    ['warning', theme.warning, theme.warningSubtle],
    ['danger', theme.danger, theme.dangerSubtle],
    ['price', theme.price, theme.priceSubtle],
  ];

  it.each(pairs)('%s clears AA on surface, background and its own tint', (_label, text, subtle) => {
    expect(contrast(text, theme.surface)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(text, theme.background)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(text, flatten(subtle, theme.background))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  /**
   * Each filled tier against its own `on*`, not against a shared one. They hold
   * the same value today; asserting them separately is what lets one of them
   * move later without the others silently coming along.
   */
  /**
   * A filled tier that becomes a *control* — a button on a card rather than a
   * pill in a row — also has to show its own edge. Only the two that are
   * actually used that way are asserted: `successSurface` and `warningSurface`
   * sit at 2.3:1 and 2.2:1 of white and would fail, which is exactly why they
   * stay pills.
   */
  it('the filled tiers used as controls show an edge against the card', () => {
    for (const fill of [theme.dangerSurface, theme.priceSurface]) {
      expect(contrast(fill, theme.surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('every filled status tier is legible under its own on-colour', () => {
    const filled: [string, string][] = [
      [theme.onSuccess, theme.successSurface],
      [theme.onWarning, theme.warningSurface],
      [theme.onDanger, theme.dangerSurface],
      [theme.onPrice, theme.priceSurface],
      [theme.onAccent, theme.accent],
    ];
    for (const [ink, fill] of filled) {
      expect(contrast(ink, fill)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});

describe.each(THEMES)('%s theme — focus indicator', (_name, theme) => {
  /**
   * The mandate is 3:1 on *every* background, including the accent. No single
   * colour can do that across a white card and a lime button, so the indicator
   * is two strokes and the assertion is that at least one of them always wins.
   */
  it('keeps at least one stroke above 3:1 on every surface, accent included', () => {
    const backdrops = [
      ...surfaces(theme).map(([, surface]) => surface),
      theme.accent,
      theme.accentPressed,
      flatten(theme.accentSubtle, theme.background),
      theme.successSurface,
      theme.warningSurface,
      theme.dangerSurface,
    ];
    for (const backdrop of backdrops) {
      const best = Math.max(
        contrast(theme.focusRing, backdrop),
        contrast(theme.focusRingInverse, backdrop),
      );
      expect(best).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  /**
   * The stronger form of the same mandate. Rather than sample the surfaces that
   * exist today, sweep every luminance a surface could ever have and check the
   * indicator survives all of them — including colours no token defines yet, and
   * photography, which the feed is full of.
   *
   * The worst case is the luminance where the two strokes are equally bad, and
   * even there the better of the two holds 4.35:1 (light) / 4.19:1 (dark). The
   * indicator therefore cannot be defeated by any background whatsoever.
   */
  it('holds above 3:1 against every possible luminance, not just our surfaces', () => {
    let worst = Infinity;
    for (let step = 0; step <= 1000; step += 1) {
      const y = step / 1000;
      const against = (colour: string) => {
        const l = luminance(colour);
        return (Math.max(y, l) + 0.05) / (Math.min(y, l) + 0.05);
      };
      worst = Math.min(worst, Math.max(against(theme.focusRing), against(theme.focusRingInverse)));
    }
    expect(worst).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it('is independent of the accent, so re-skinning cannot dim it', () => {
    expect(theme.focusRing).not.toBe(theme.accent);
    expect(theme.focusRingInverse).not.toBe(theme.accent);
  });

  it('draws its two strokes against each other', () => {
    expect(contrast(theme.focusRing, theme.focusRingInverse)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('generated CSS', () => {
  it('matches the committed tokens.css', () => {
    const committed = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
    expect(committed).toBe(renderTokensCss());
  });
});
