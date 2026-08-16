/**
 * TRY design tokens — the single source of spacing, colour, type and motion.
 *
 * Shared by mobile and web so a "primary" button means the same thing in both.
 * Implementations differ (StyleSheet vs Tailwind), the values do not. The web
 * side does not copy these values: `tokens.css` is generated from this file by
 * `scripts/generate-css.mjs`, and both dashboards import it.
 *
 * The palette is deliberately narrow. TRY sells trust and clarity: large
 * photography, high contrast, one confident accent. Not twenty colours and a
 * gradient.
 *
 * Contrast is a contract, not an aspiration: every pairing this file sanctions
 * is asserted in `tokens.test.ts` against WCAG 2.1 AA. Changing a value here
 * without running that suite is how an accessible palette quietly stops being
 * one.
 */

/**
 * Warm neutral ramp.
 *
 * Four steps are taken verbatim from the brand charter — ink900 `#111111`,
 * ink800 `#2A2A2A`, ink200 `#E9E9E5`, ink50 `#F7F7F2`. The rest are derived in
 * CIE Lab at hue 100° (yellow) with a chroma that grows toward the light end,
 * because dark greys read as tinted far more readily than pale ones do.
 *
 * The steps are NOT evenly spaced, and that is deliberate. AA text on a ~L*95
 * background has to sit at or below ~L*44; AA text on a ~L*20 background has to
 * sit at or above ~L*65. The ramp is therefore dense at both ends — where text
 * actually lives — and sparse through the middle, which only ever carries
 * borders.
 */
export const palette = {
  /** Below ink900. Dark-theme sunken surfaces only. */
  ink950: '#0A0907',
  /** Charter: INK BLACK. Light-theme primary text, dark-theme background. */
  ink900: '#111111',
  /** Charter: DARK GRAY. Dark-theme card surface. */
  ink800: '#2A2A2A',
  ink700: '#3E3E3C',
  ink600: '#666663',
  ink500: '#858480',
  ink400: '#ACABA7',
  ink300: '#D3D2CD',
  /** Charter: SOFT GRAY — the charter assigns it to borders and separators. */
  ink200: '#E9E9E5',
  ink100: '#F0EFEB',
  /** Charter: OFF-WHITE. The light-theme page background. */
  ink50: '#F7F7F2',
  white: '#FFFFFF',

  /**
   * Accent: the charter's acid lime.
   *
   * It has a relative luminance of 0.84 — optically almost as bright as white.
   * That makes it excellent as a *fill* with ink on top (16:1) and unusable as
   * text or as a border on any light surface (1.18:1 on white, below even the
   * 3:1 non-text floor). `lime800` exists for those cases; see `accentText`.
   */
  lime500: '#C6FF36',
  /** Pressed. Charter reference sampled at #9BC802; derived here at -12 L*. */
  lime600: '#A4DC00',
  /** Same hue darkened until it clears AA as text on every light surface. */
  lime800: '#397A00',
  lime50: '#F5F6DC',

  /**
   * Reserved for prices and discovery pricing — never decorative. The accent
   * says "act"; this says "costs money". The charter mockups collapse the two
   * into one lime, which is exactly the distinction we are keeping.
   */
  signal600: '#C2410C',
  signal500: '#EA580C',
  signal50: '#FFF3EC',

  /**
   * Status colours, kept from the previous palette rather than taken from the
   * charter: every charter variant lands between 1.7:1 and 3.8:1 as text on
   * white and fails AA outright. These clear it.
   */
  success600: '#15803D',
  success50: '#EAF7EF',
  warning600: '#A16207',
  warning50: '#FEF7E6',
  danger600: '#B91C1C',
  /**
   * Dark-theme danger. Kept at this value even though it does not clear AA as
   * text on the dark surfaces: `Button`'s danger variant paints it as a *fill*
   * under hardcoded white text, and anything light enough to read as text drops
   * that button to 1.9:1. See the note in tokens.test.ts.
   */
  danger500: '#DC2626',
  danger50: '#FEECEC',

  /**
   * The charter's vivid status tier, kept for what it is actually good at:
   * filled pills and dots carrying dark text. Never as text itself.
   */
  successSurface: '#22C55E',
  warningSurface: '#F59E0B',
  dangerSurface: '#EF4444',

  /** Dark-theme status text. Lightened until each clears AA on ink700. */
  successDark: '#4ADE80',
  warningDark: '#FBBF24',
  priceDark: '#FB923C',
} as const;

/**
 * Semantic layer. Components reference these, never raw palette entries, so a
 * dark theme is a change to this map alone.
 *
 * Declared as an explicit interface rather than inferred from `lightTheme`:
 * inferring with `as const` would give each token a *literal* type, and the dark
 * theme would then fail to satisfy it because "#0B0F14" is not "#FFFFFF".
 */
export interface Theme {
  background: string;
  backgroundElevated: string;
  backgroundSunken: string;
  surface: string;
  surfaceMuted: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  /** Text on an inverted surface: an overlay, a photo scrim, a dark banner. */
  textInverse: string;

  border: string;
  borderStrong: string;

  /** Accent as a fill. Put `onAccent` on top of it, never light text. */
  accent: string;
  accentPressed: string;
  accentSubtle: string;
  onAccent: string;
  /**
   * Accent as text, an icon, or a border. A separate token because the fill
   * value cannot do this job on a light surface at any size.
   */
  accentText: string;

  price: string;
  priceSubtle: string;

  success: string;
  successSubtle: string;
  successSurface: string;
  warning: string;
  warningSubtle: string;
  warningSurface: string;
  danger: string;
  dangerSubtle: string;
  dangerSurface: string;

  /**
   * Focus indicator, drawn as two concentric strokes: `focusRing` on the
   * outside, `focusRingInverse` hugging the element inside it.
   *
   * A single colour cannot clear 3:1 against both a white card and a lime
   * button, so neither stroke tries to. Because the two sit at opposite ends of
   * the ramp, the worst case for *both* at once is still 4.2:1 — there is no
   * surface on which the indicator disappears. Neither is derived from the
   * accent, which is what stops a re-skin from dimming it.
   */
  focusRing: string;
  focusRingInverse: string;

  skeleton: string;
  overlay: string;
}

export const lightTheme: Theme = {
  background: palette.ink50,
  backgroundElevated: palette.white,
  backgroundSunken: palette.ink100,
  surface: palette.white,
  surfaceMuted: palette.ink100,

  textPrimary: palette.ink900,
  textSecondary: palette.ink700,
  textTertiary: palette.ink600,
  textInverse: palette.white,

  border: palette.ink200,
  borderStrong: palette.ink500,

  accent: palette.lime500,
  accentPressed: palette.lime600,
  accentSubtle: palette.lime50,
  onAccent: palette.ink900,
  accentText: palette.lime800,

  price: palette.signal600,
  priceSubtle: palette.signal50,

  success: palette.success600,
  successSubtle: palette.success50,
  successSurface: palette.successSurface,
  warning: palette.warning600,
  warningSubtle: palette.warning50,
  warningSurface: palette.warningSurface,
  danger: palette.danger600,
  dangerSubtle: palette.danger50,
  dangerSurface: palette.dangerSurface,

  focusRing: palette.ink900,
  focusRingInverse: palette.white,

  skeleton: palette.ink200,
  overlay: 'rgba(17, 17, 17, 0.55)',
};

export const darkTheme: Theme = {
  background: palette.ink900,
  backgroundElevated: palette.ink800,
  backgroundSunken: palette.ink950,
  surface: palette.ink800,
  surfaceMuted: palette.ink700,

  textPrimary: palette.ink50,
  textSecondary: palette.ink300,
  textTertiary: palette.ink400,
  textInverse: palette.ink900,

  border: palette.ink700,
  borderStrong: palette.ink400,

  /** The lime needs no dark-theme variant: it clears 9:1 on every dark surface. */
  accent: palette.lime500,
  accentPressed: palette.lime600,
  accentSubtle: 'rgba(198, 255, 54, 0.16)',
  onAccent: palette.ink900,
  /** On dark surfaces the fill value *is* the text-safe one. */
  accentText: palette.lime500,

  price: palette.priceDark,
  priceSubtle: 'rgba(251, 146, 60, 0.14)',

  success: palette.successDark,
  successSubtle: 'rgba(74, 222, 128, 0.14)',
  successSurface: palette.successSurface,
  warning: palette.warningDark,
  warningSubtle: 'rgba(251, 191, 36, 0.14)',
  warningSurface: palette.warningSurface,
  danger: palette.danger500,
  dangerSubtle: 'rgba(220, 38, 38, 0.16)',
  dangerSurface: palette.dangerSurface,

  focusRing: palette.ink50,
  focusRingInverse: palette.ink900,

  skeleton: palette.ink700,
  overlay: 'rgba(0, 0, 0, 0.65)',
};

/** 4pt grid. Every gap in the product is one of these. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  huge: 64,
} as const;

export const radius = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  xxl: 28,
  pill: 999,
} as const;

/**
 * Type scale. `lineHeight` is absolute rather than a multiplier because React
 * Native treats the two differently from CSS and inconsistency there is the most
 * common source of misaligned text between platforms.
 *
 * Headings carry the charter's airier leading — its H3 sits at 18/28. The ratio
 * loosens as the type gets smaller (1.24 → 1.29 → 1.36 → 1.56), which is the
 * usual relationship: large type needs proportionally less room to breathe.
 * Body and caption already matched the charter exactly and are untouched.
 */
export const typography = {
  display: { fontSize: 34, lineHeight: 42, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 36, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
  title3: { fontSize: 18, lineHeight: 28, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.6 },
} as const;

/**
 * Shadows are soft and low. A discovery feed is mostly photography; heavy
 * elevation competes with it. The charter's own scale lands within a pixel or
 * two of these, so the values stand.
 */
export const shadows = {
  none: { shadowOpacity: 0, elevation: 0 },
  sm: {
    shadowColor: palette.ink900,
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  md: {
    shadowColor: palette.ink900,
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  lg: {
    shadowColor: palette.ink900,
    shadowOpacity: 0.14,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} as const;

/**
 * Motion. Durations stay short: the app should feel like it is responding, not
 * performing. Every one of these is skipped when the OS reports reduced motion.
 */
export const motion = {
  instant: 120,
  fast: 180,
  base: 240,
  slow: 320,
  /** Spring for gestures and sheets; critically damped enough not to wobble. */
  spring: { damping: 20, stiffness: 220, mass: 1 },
  springSnappy: { damping: 26, stiffness: 320, mass: 0.9 },
} as const;

/** iOS HIG and Material both land on 44–48pt; 48 is the safer floor for gloves-on gym use. */
export const touchTarget = {
  minimum: 48,
} as const;

/** Focus ring geometry, shared so mobile and web draw the same indicator. */
export const focusRing = {
  /** Width of the outer stroke — the one drawn in `focusRing`. */
  width: 2,
  /**
   * Gap between the element and the outer stroke, in px. The inner companion
   * stroke fills exactly this gap, so the two numbers are the same by
   * construction rather than by coincidence.
   */
  offset: 2,
} as const;

export const layout = {
  screenPadding: spacing.base,
  cardGap: spacing.md,
  sectionGap: spacing.xxl,
  /** Feed cards: 3:2 keeps photography generous without pushing price below the fold. */
  cardAspectRatio: 3 / 2,
  heroAspectRatio: 4 / 3,
} as const;
