'use client';

import { ApiClient, createEndpoints } from '@try/api-client';
import type { TokenStore } from '@try/api-client';

const ACCESS_TOKEN_KEY = 'try.admin.accessToken';
const REFRESH_TOKEN_KEY = 'try.admin.refreshToken';

/**
 * Browser token storage.
 *
 * localStorage is readable by any script on the origin, so this is only
 * defensible alongside the strict CSP in next.config.ts, which blocks third-party
 * scripts outright. The stronger option — httpOnly cookies issued by the API —
 * is the intended next step and is tracked in docs/security.md; it needs CSRF
 * protection on every mutation, which is a change on the API side.
 */
class BrowserTokenStore implements TokenStore {
  getAccessToken(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  }

  setTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    window.localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
    window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    return Promise.resolve();
  }
}

export const tokenStore = new BrowserTokenStore();

export const apiClient = new ApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
  tokens: tokenStore,
  onUnauthenticated: () => {
    if (typeof window !== 'undefined') window.location.href = '/sign-in';
  },
  clientInfo: { name: 'try-admin', version: '0.1.0' },
});

export const api = createEndpoints(apiClient);
