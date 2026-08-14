/**
 * TRY design tokens — the single source of spacing, colour, type and motion.
 *
 * Shared by mobile and web so a "primary" button means the same thing in both.
 * Implementations differ (StyleSheet vs Tailwind), the values do not.
 *
 * The palette is deliberately narrow. TRY sells trust and clarity: large
 * photography, high contrast, one confident accent. Not twenty colours and a
 * gradient.
 */

export const palette = {
  /**
   * Ink, not pure black. #000 against white is harsh at large type sizes and
   * reads as unfinished on OLED.
   */
  ink900: '#0B0F14',
  ink800: '#151B23',
  ink700: '#232B36',
  ink600: '#3A4553',
  ink500: '#5A6675',
  ink400: '#8593A3',
  ink300: '#B4BFCB',
  ink200: '#D9E0E7',
  ink100: '#ECF0F4',
  ink50: '#F6F8FA',
  white: '#FFFFFF',

  /**
   * Accent: a deep energetic green. Sport without the shouty neon of a gym
   * chain, and it passes AA on white at text sizes.
   */
  accent700: '#0A6E4E',
  accent600: '#0E8A61',
  accent500: '#12A576',
  accent400: '#3DBE93',
  accent200: '#A7E2CD',
  accent50: '#E8F7F1',

  /** Reserved for prices and discovery pricing — never decorative. */
  signal600: '#C2410C',
  signal500: '#EA580C',
  signal50: '#FFF3EC',

  success600: '#15803D',
  success50: '#EAF7EF',
  warning600: '#A16207',
  warning50: '#FEF7E6',
  danger600: '#B91C1C',
  danger500: '#DC2626',
  danger50: '#FEECEC',
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
  textInverse: string;
  textOnAccent: string;

  border: string;
  borderStrong: string;

  accent: string;
  accentPressed: string;
  accentSubtle: string;
  onAccent: string;

  price: string;
  priceSubtle: string;

  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerSubtle: string;

  skeleton: string;
  overlay: string;
}

export const lightTheme: Theme = {
  background: palette.white,
  backgroundElevated: palette.white,
  backgroundSunken: palette.ink50,
  surface: palette.white,
  surfaceMuted: palette.ink100,

  textPrimary: palette.ink900,
  textSecondary: palette.ink500,
  textTertiary: palette.ink400,
  textInverse: palette.white,
  textOnAccent: palette.white,

  border: palette.ink200,
  borderStrong: palette.ink300,

  accent: palette.accent600,
  accentPressed: palette.accent700,
  accentSubtle: palette.accent50,
  onAccent: palette.white,

  price: palette.signal600,
  priceSubtle: palette.signal50,

  success: palette.success600,
  successSubtle: palette.success50,
  warning: palette.warning600,
  warningSubtle: palette.warning50,
  danger: palette.danger600,
  dangerSubtle: palette.danger50,

  skeleton: palette.ink100,
  overlay: 'rgba(11, 15, 20, 0.55)',
};

export const darkTheme: Theme = {
  background: palette.ink900,
  backgroundElevated: palette.ink800,
  backgroundSunken: '#070A0E',
  surface: palette.ink800,
  surfaceMuted: palette.ink700,

  textPrimary: '#F2F5F8',
  textSecondary: palette.ink300,
  textTertiary: palette.ink400,
  textInverse: palette.ink900,
  textOnAccent: palette.white,

  border: palette.ink700,
  borderStrong: palette.ink600,

  accent: palette.accent500,
  accentPressed: palette.accent400,
  accentSubtle: 'rgba(18, 165, 118, 0.16)',
  onAccent: palette.ink900,

  price: '#FB923C',
  priceSubtle: 'rgba(251, 146, 60, 0.14)',

  success: '#4ADE80',
  successSubtle: 'rgba(74, 222, 128, 0.14)',
  warning: '#FBBF24',
  warningSubtle: 'rgba(251, 191, 36, 0.14)',
  danger: palette.danger500,
  dangerSubtle: 'rgba(220, 38, 38, 0.16)',

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
 */
export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.6 },
} as const;

/**
 * Shadows are soft and low. A discovery feed is mostly photography; heavy
 * elevation competes with it.
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

export const layout = {
  screenPadding: spacing.base,
  cardGap: spacing.md,
  sectionGap: spacing.xxl,
  /** Feed cards: 3:2 keeps photography generous without pushing price below the fold. */
  cardAspectRatio: 3 / 2,
  heroAspectRatio: 4 / 3,
} as const;
