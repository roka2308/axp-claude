import { expect, test } from '@playwright/test';
import { FIXTURE_SKIP_REASON, VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_STATE } from './session';

/**
 * Password recovery and the verified address change (Phase 10, DEV-005).
 *
 * The mail itself is read by the integration suite and Gate F10; here the
 * browser shows what a person sees: the same answer for every address, a
 * used link that says how to get a new one, and an address change that waits
 * for its confirmation and can be cancelled.
 */

test.describe('forgot password', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('gives the same answer for any address, reachable from the sign-in page', async ({
    page,
  }) => {
    const answers: string[] = [];
    for (const email of [
      'niemand@example.invalid',
      VIEWER_EMAIL ?? 'viewer.demo@example.invalid',
    ]) {
      await page.goto('/login');
      await page.getByRole('link', { name: 'Passwort vergessen?' }).click();
      await expect(page.getByRole('heading', { name: 'Passwort vergessen' })).toBeVisible();
      await page.getByLabel(/^E-Mail-Adresse/).fill(email);
      await page.getByRole('button', { name: 'Link anfordern' }).click();
      const answer = page.getByRole('status').or(page.getByRole('alert'));
      await expect(page.getByText('Anfrage angenommen')).toBeVisible();
      answers.push((await answer.first().textContent()) ?? '');
    }
    expect(answers[0]).toBe(answers[1]);
  });

  test('a used or unknown link says so and offers a new one', async ({ page }) => {
    await page.goto('/reset-password?token=unbekannt-0000000000');
    await expect(page.getByText('Link nicht mehr gültig')).toBeVisible();
    await page.getByRole('link', { name: 'Neuen Link anfordern' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});

test.describe('changing my e-mail address', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('needs the password, then waits for the new address and can be cancelled', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'One run is enough.');
    await page.goto('/profile');
    const form = page.locator('form').filter({ has: page.getByLabel(/^Neue E-Mail-Adresse/) });
    await form.getByLabel(/^Neue E-Mail-Adresse/).fill('viewer.neu@example.invalid');
    await form.getByLabel(/^Aktuelles Passwort/).fill('falsch-falsch-falsch');
    await form.getByRole('button', { name: 'Bestätigungslink senden' }).click();
    await expect(page.getByText('Das aktuelle Passwort ist nicht korrekt.').first()).toBeVisible();

    await form.getByLabel(/^Aktuelles Passwort/).fill(VIEWER_PASSWORD);
    await form.getByRole('button', { name: 'Bestätigungslink senden' }).click();
    await expect(page.getByText('Bestätigung ausstehend')).toBeVisible();
    await expect(page.getByText(/viewer\.neu@example\.invalid/).first()).toBeVisible();

    // Still signed in under the old address; the change is only pending.
    await page.reload();
    await expect(page.getByText('Bestätigung ausstehend')).toBeVisible();
    await page.getByRole('button', { name: 'Änderung abbrechen' }).click();
    await expect(page.getByText(/Die Änderung wurde abgebrochen/)).toBeVisible();
    await expect(page.getByText('Bestätigung ausstehend')).toHaveCount(0);
  });
});
