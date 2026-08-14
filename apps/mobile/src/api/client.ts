import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { ApiClient, createEndpoints } from '@try/api-client';
import type { TokenStore } from '@try/api-client';

const ACCESS_TOKEN_KEY = 'try.accessToken';
const REFRESH_TOKEN_KEY = 'try.refreshToken';

/**
 * Tokens live in the device keychain / keystore, never in AsyncStorage.
 * AsyncStorage is plain text on disk and readable on a rooted device.
 *
 * An in-memory mirror of the access token keeps the common path off the
 * keychain, which is comparatively slow and would otherwise be hit on every
 * request in a feed scroll.
 */
class SecureTokenStore implements TokenStore {
  private accessTokenCache: string | null = null;

  async getAccessToken(): Promise<string | null> {
    this.accessTokenCache ??= await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
    return this.accessTokenCache;
  }

  getRefreshToken(): Promise<string | null> {
    return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  }

  async setTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    this.accessTokenCache = tokens.accessToken;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_TOKEN_KEY, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH_TOKEN_KEY, tokens.refreshToken),
    ]);
  }

  async clear(): Promise<void> {
    this.accessTokenCache = null;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    ]);
  }
}

export const tokenStore = new SecureTokenStore();

const apiUrl =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'http://localhost:3000';

let onUnauthenticated: (() => void) | undefined;

/** Set by the root layout so an expired session routes to sign-in from anywhere. */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

export const apiClient = new ApiClient({
  baseUrl: apiUrl,
  tokens: tokenStore,
  onUnauthenticated: () => onUnauthenticated?.(),
  clientInfo: { name: 'try-mobile', version: '0.1.0' },
});

export const api = createEndpoints(apiClient);
