import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { motion } from '@try/design-tokens';

/**
 * Reduced-motion support.
 *
 * Not a nicety: for users with vestibular disorders, large-scale motion causes
 * real nausea. Every animation in TRY reads this and collapses to an instant
 * state change when it is on.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduced(enabled);
    });

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (mounted) setReduced(enabled);
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}

/** Duration helper that honours the setting without every caller repeating the check. */
export function useDuration(): (value: keyof typeof motion | number) => number {
  const reduced = useReducedMotion();
  return (value) => {
    if (reduced) return 0;
    return typeof value === 'number' ? value : (motion[value] as number);
  };
}
