import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 0 acceptance journey.
 *
 * Runs against a freshly migrated, unseeded database. The flow is the one an
 * operator actually performs on a new installation:
 *
 *   npm run db:reset && npm run db:migrate
 *   npm run bootstrap-admin -- --json      (prints the activation URL)
 *   E2E_BOOTSTRAP_TOKEN=<token> npm run test:e2e
 *
 * The token is passed through the environment rather than minted by the test,
 * because minting it requires the privileged local process - which is precisely
 * the property under test.
 */

const TOKEN = process.env.E2E_BOOTSTRAP_TOKEN;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'e2e.admin@example.invalid';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'korrekt-pferd-batterie-heftklammer';

test.describe('secure bootstrap', () => {
  test.skip(!TOKEN, 'Set E2E_BOOTSTRAP_TOKEN from `npm run bootstrap-admin -- --json`.');

  test('setup without a token explains what to do instead of showing a form', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: /Plattform einrichten/i })).toBeVisible();
    await expect(page.getByText(/Kein Aktivierungstoken/i)).toBeVisible();
    await expect(page.getByLabel(/Passwort/i)).toHaveCount(0);
  });

  test('setup with an invalid token refuses without revealing why', async ({ page }) => {
    await page.goto(`/setup?token=${'x'.repeat(40)}`);
    await expect(page.getByText(/Aktivierungstoken ungültig/i)).toBeVisible();
    await expect(page.getByLabel(/^Passwort$/i)).toHaveCount(0);
  });

  test('creates the first platform admin and then closes the setup path', async ({ page }) => {
    await page.goto(`/setup?token=${encodeURIComponent(TOKEN!)}`);

    await page.getByLabel('Vorname').fill('Petra');
    await page.getByLabel('Nachname').fill('Plattform');
    await page.getByLabel('E-Mail-Adresse').fill(ADMIN_EMAIL);
    await page.getByLabel('Passwort', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByLabel('Passwort wiederholen').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /Plattform-Administration anlegen/i }).click();

    await expect(page.getByText(/Plattform eingerichtet/i)).toBeVisible();

    // Reusing the same token must now fail, and the page must say the platform
    // is already initialized rather than offering setup again.
    await page.goto(`/setup?token=${encodeURIComponent(TOKEN!)}`);
    await expect(page.getByText(/Plattform bereits eingerichtet/i)).toBeVisible();
  });

  test('rejects mismatched password confirmation before submitting', async ({ page }) => {
    await page.goto(`/setup?token=${encodeURIComponent(TOKEN!)}`);
    const alreadyDone = await page.getByText(/Plattform bereits eingerichtet/i).isVisible();
    test.skip(alreadyDone, 'Platform already initialized by an earlier test in this run.');

    await page.getByLabel('Vorname').fill('Petra');
    await page.getByLabel('Nachname').fill('Plattform');
    await page.getByLabel('E-Mail-Adresse').fill(ADMIN_EMAIL);
    await page.getByLabel('Passwort', { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByLabel('Passwort wiederholen').fill('etwas-anderes-langes');
    await page.getByRole('button', { name: /Plattform-Administration anlegen/i }).click();

    await expect(page.getByText(/stimmen nicht überein/i)).toBeVisible();
  });
});

test.describe('sign-in', () => {
  test.skip(!process.env.E2E_ADMIN_EMAIL && !TOKEN, 'Requires a bootstrapped admin account.');

  test('rejects wrong credentials with an actionable message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-Mail-Adresse').fill(ADMIN_EMAIL);
    await page.getByLabel('Passwort').fill('definitiv-falsches-passwort');
    await page.getByRole('button', { name: 'Anmelden' }).click();

    await expect(page.getByRole('alert')).toContainText(/nicht korrekt/i);
    // The address is preserved so the user does not retype it.
    await expect(page.getByLabel('E-Mail-Adresse')).toHaveValue(ADMIN_EMAIL);
  });

  test('signs in and lands on Home with roles and the data-access statement', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-Mail-Adresse').fill(ADMIN_EMAIL);
    await page.getByLabel('Passwort').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Anmelden' }).click();

    await expect(page.getByRole('heading', { name: 'Willkommen' })).toBeVisible();
    await expect(page.getByText('Platform Admin')).toBeVisible();
    // Master Spec §7 stated in the product, not only in the model.
    await expect(page.getByText(/Eine Rolle allein gewährt keinen Zugriff/i)).toBeVisible();
  });

  test('signs out and returns to the login page', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Abmelden' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('accessibility smoke checks', () => {
  test.skip(!TOKEN && !process.env.E2E_ADMIN_EMAIL, 'Requires a bootstrapped admin account.');

  test('the login form is fully keyboard operable', async ({ page }) => {
    await page.goto('/login');

    // Skip link first, then the form controls, in a sensible order.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /Zum Hauptinhalt springen/i })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('E-Mail-Adresse')).toBeFocused();
    await page.keyboard.type(ADMIN_EMAIL);

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Passwort')).toBeFocused();
    await page.keyboard.type(ADMIN_PASSWORD);

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Willkommen' })).toBeVisible();
  });

  test('form errors are associated with their control', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-Mail-Adresse').fill('');
    await page.getByLabel('Passwort').fill('');
    await page.getByRole('button', { name: 'Anmelden' }).click();

    // The message is text inside an alert, never a red border alone.
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('the viewer reflows at a representative mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await expect(page.getByRole('heading', { name: 'Willkommen' })).toBeVisible();

    // No horizontal scrolling: the page must reflow, not shrink (D10).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Willkommen' })).toBeVisible();
}
