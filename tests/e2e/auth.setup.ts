import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, test as setup } from '@playwright/test';
import { DEMO_ACCOUNTS, VIEWER_EMAIL, VIEWER_PASSWORD } from './session';

/**
 * Signs each demo role in once and stores its session.
 *
 * Not a convenience: `/auth/login` is rate limited per client, because
 * brute-force protection is an acceptance criterion. A suite that signed in on
 * every case would hit that limit and report a product safeguard as a test
 * failure (Master Spec §8).
 *
 * `bootstrap-and-login.spec.ts` deliberately does not use these states -
 * sign-in and sign-out are what it tests.
 */
setup('authenticate the demo roles', async ({ page }) => {
  mkdirSync(path.dirname(DEMO_ACCOUNTS.viewer.state), { recursive: true });

  for (const account of Object.values(DEMO_ACCOUNTS)) {
    if (!VIEWER_EMAIL || !account.email) {
      // The specs that need a state skip themselves, but a storage state is
      // read before a test can skip, so the file still has to exist.
      writeFileSync(account.state, JSON.stringify({ cookies: [], origins: [] }));
      continue;
    }

    await signIn(page, account.email);
    await page.context().storageState({ path: account.state });

    // Drop the cookie locally rather than signing out: `/auth/logout` revokes
    // the session server-side, which would invalidate the state just saved.
    await page.context().clearCookies();
  }
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(VIEWER_PASSWORD);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Willkommen' })).toBeVisible();
}
