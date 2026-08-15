import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Stockage des jetons, avec une implémentation par plateforme.
 *
 * Sur iOS et Android : le trousseau / keystore du système, jamais AsyncStorage
 * qui est du texte clair lisible sur un appareil rooté.
 *
 * Sur le web : `expo-secure-store` n'existe tout simplement pas — il n'y a pas
 * de trousseau dans un navigateur. On retombe sur localStorage, ce qui est
 * acceptable UNIQUEMENT pour la prévisualisation et la démo : c'est le même
 * compromis que les apps web business/admin, et la note de sécurité vaut aussi
 * ici (docs/security.md, « jetons web dans localStorage »).
 */
const isWeb = Platform.OS === 'web';

export async function getSecureItem(key: string): Promise<string | null> {
  if (isWeb) {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecureItem(key: string): Promise<void> {
  if (isWeb) {
    if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}
