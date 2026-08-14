import { useColorScheme } from 'react-native';
import {
  darkTheme,
  layout,
  lightTheme,
  motion,
  radius,
  shadows,
  spacing,
  touchTarget,
  typography,
} from '@try/design-tokens';
import type { Theme } from '@try/design-tokens';

export { spacing, radius, typography, shadows, motion, layout, touchTarget };
export type { Theme };

/**
 * Follows the OS appearance. Users who set their phone to dark at the gym expect
 * every app to respect it; overriding that is a small betrayal of trust.
 */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

export function useIsDark(): boolean {
  return useColorScheme() === 'dark';
}
