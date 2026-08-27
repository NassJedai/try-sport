import Constants from 'expo-constants';
import { deleteSecureItem, getSecureItem, setSecureItem } from './secure-storage';
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

  /**
   * Est-ce que le dernier `clear()` a réellement jeté un jeton, c'est-à-dire
   * s'il y avait une session à perdre.
   *
   * Lu par le gestionnaire de 401 global (plus bas) pour distinguer « ta
   * session vient d'expirer » — ça mérite l'écran de connexion — de « tu ne
   * t'es jamais connecté » — un visiteur en mode « Explorer sans compte » qui
   * touche un endpoint protégé (la cloche, les favoris, les réservations) n'a
   * rien à perdre et ne doit pas être éjecté. Recalculé à chaque `clear()`,
   * jamais figé depuis le démarrage à froid.
   */
  private hadSessionAtLastClearFlag = false;

  async getAccessToken(): Promise<string | null> {
    this.accessTokenCache ??= await getSecureItem(ACCESS_TOKEN_KEY);
    return this.accessTokenCache;
  }

  getRefreshToken(): Promise<string | null> {
    return getSecureItem(REFRESH_TOKEN_KEY);
  }

  async setTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    this.accessTokenCache = tokens.accessToken;
    await Promise.all([
      setSecureItem(ACCESS_TOKEN_KEY, tokens.accessToken),
      setSecureItem(REFRESH_TOKEN_KEY, tokens.refreshToken),
    ]);
  }

  async clear(): Promise<void> {
    this.hadSessionAtLastClearFlag =
      this.accessTokenCache !== null || (await getSecureItem(REFRESH_TOKEN_KEY)) !== null;
    this.accessTokenCache = null;
    await Promise.all([
      deleteSecureItem(ACCESS_TOKEN_KEY),
      deleteSecureItem(REFRESH_TOKEN_KEY),
    ]);
  }

  get hadSessionAtLastClear(): boolean {
    return this.hadSessionAtLastClearFlag;
  }
}

export const tokenStore = new SecureTokenStore();

/**
 * Résout l'URL de l'API pour l'environnement de développement.
 *
 * `localhost` ne veut rien dire depuis un vrai téléphone : il pointe vers le
 * téléphone lui-même. Expo expose l'adresse du poste de dev via `hostUri`
 * (« 192.168.x.x:8081 ») — on réutilise cet hôte avec le port de l'API, si bien
 * que scanner le QR d'Expo Go suffit, sans rien configurer. Une URL explicite
 * dans `extra.apiUrl` (staging, production) garde toujours la priorité.
 */
function resolveApiUrl(): string {
  const explicit = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;

  if (explicit && !explicit.includes('localhost')) return explicit;

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:3000`;
    }
  }

  return explicit ?? 'http://localhost:3000';
}

const apiUrl = resolveApiUrl();

let onUnauthenticated: (() => void) | undefined;

/** Set by the root layout so an expired session routes to sign-in from anywhere. */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

export const apiClient = new ApiClient({
  baseUrl: apiUrl,
  tokens: tokenStore,
  /**
   * `@try/api-client` appelle ceci sur tout 401 dont le refresh a échoué —
   * y compris quand ce refresh a échoué faute de jeton, ce qui est l'état
   * normal d'un visiteur qui n'a jamais eu de compte. Sans ce garde-fou,
   * « Explorer sans compte » touchait sa première cloche de notification et
   * se retrouvait éjecté vers l'écran de connexion : le défaut vécu le
   * 27/08, tracé jusqu'ici. Seule une session qui existait vraiment avant ce
   * clear() justifie de router vers la connexion.
   */
  onUnauthenticated: () => {
    if (tokenStore.hadSessionAtLastClear) onUnauthenticated?.();
  },
  clientInfo: { name: 'try-mobile', version: '0.1.0' },
});

export const api = createEndpoints(apiClient);
