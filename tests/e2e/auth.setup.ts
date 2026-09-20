import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import { VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_STATE } from './session';

/**
 * Signs in once and stores the session for the specs that only need to be
 * signed in.
 *
 * Not a convenience: `/auth/login` is rate limited per client, because
 * brute-force protection is an acceptance criterion. A suite that signed in on
 * every case would hit that limit and report a product safeguard as a test
 * failure (Master Spec §8).
 *
 * `bootstrap-and-login.spec.ts` deliberately does not use this state - sign-in
 * and sign-out are what it tests.
 */
setup('authenticate as the demo viewer', async ({ page }) => {
  mkdirSync(path.dirname(VIEWER_STATE), { recursive: true });

  if (!VIEWER_EMAIL) {
    // The specs that need this state skip themselves, but a storage state is
    // read before a test can skip, so the file still has to exist.
    writeFileSync(VIEWER_STATE, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }

  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(VIEWER_EMAIL);
  await page.getByLabel('Passwort').fill(VIEWER_PASSWORD);
  await page.getByRole('button', { name: 'Anmelden' }).click();

  await expect(page.getByRole('heading', { name: 'Willkommen' })).toBeVisible();
  await page.context().storageState({ path: VIEWER_STATE });
});
