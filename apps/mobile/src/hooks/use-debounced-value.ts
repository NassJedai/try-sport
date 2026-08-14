import { useEffect, useState } from 'react';

/**
 * Debounces a rapidly changing value.
 *
 * Used for search input and map viewport changes: issuing a request per keystroke
 * or per pan frame wastes the user's data and makes results flicker as
 * out-of-order responses land.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
