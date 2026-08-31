import { test } from '@playwright/test';
import { ADMIN_AUTH_FILE, ADMIN_URL, DEMO_ACCOUNTS } from '../lib/env';
import { signInWithOtp } from '../lib/login';

/**
 * Même raisonnement que `business.setup.ts`, pour le compte SUPER_ADMIN
 * démo. Le projet `admin` dépend à la fois de ce setup et du projet
 * `business` (`playwright.config.ts`) : l'ordre garanti — gérant d'abord,
 * admin ensuite — est ce qui permet au test `admin-alerts.spec.ts` de
 * vérifier une alerte que le gérant vient de produire.
 */
test('l’équipe TRIALYA se connecte', async ({ page, request }) => {
  await signInWithOtp(page, request, ADMIN_URL, DEMO_ACCOUNTS.admin);
  await page.context().storageState({ path: ADMIN_AUTH_FILE });
});
