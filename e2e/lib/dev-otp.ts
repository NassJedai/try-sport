import type { APIRequestContext } from '@playwright/test';
import { API_URL } from './env';

/**
 * Lit le dernier code OTP émis pour `email`, via l'endpoint dev-only ajouté
 * dans `apps/api/src/modules/auth/auth.controller.ts`
 * (`GET /v1/auth/dev/last-otp`). Ne DEMANDE jamais de code elle-même — c'est
 * volontairement le rôle exclusif du clic réel sur « Recevoir mon code » dans
 * `signInWithOtp` (voir `lib/login.ts`), pour que chaque connexion scriptée
 * ne consomme qu'UNE seule requête sur le budget `otpRequest`
 * (5 / 15 min par IP, en mémoire — voir la note de mémoire sur ce piège).
 *
 * Cet endpoint est lui-même inerte hors développement local
 * (`AUTH_DEV_ECHO_OTP && isLocal`, la même garde que le log `devLoginCode`
 * déjà en place) : il répond 404 dès que la garde est fermée, jamais un code
 * qui n'existe pas.
 */
export async function readLastOtp(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.get(`${API_URL}/v1/auth/dev/last-otp`, {
    params: { email },
  });
  if (!response.ok()) {
    throw new Error(
      `GET /v1/auth/dev/last-otp a échoué (${response.status()}) pour ${email}. ` +
        `AUTH_DEV_ECHO_OTP=true et APP_ENV=local sont-ils actifs sur l'instance API testée ? ` +
        (await response.text()),
    );
  }
  const body = (await response.json()) as { code: string };
  return body.code;
}
