import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_SKIP_REASON,
  PLATFORM_ADMIN_STATE,
  TENANT_ADMIN_STATE,
  VIEWER_EMAIL,
  VIEWER_PASSWORD,
  VIEWER_STATE,
} from './session';

/**
 * Phase 5 administration journey (D5, Gate F5).
 *
 * The gate question - "What can this user do, where, and why?" - answered in
 * the browser, from the page alone: capabilities per scope with the chain that
 * produces them, data access per dashboard with the missing half named, and
 * every permission change previewed before it is made. Around it, the parts
 * of D5 only a browser shows: that Platform Admin is never offered to a Tenant
 * Admin, that a Platform Admin sees no customer data, the tenant wizard, a
 * lifecycle change behind a typed confirmation, and an invitation link that
 * works exactly once.
 */

const RUN = Date.now().toString(36);
const TENANT = `Gate F5 Kunde ${RUN}`;

test.describe('administration: effective access', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: TENANT_ADMIN_STATE });

  test('answers what a person can do, where, and why', async ({ page }) => {
    await openPerson(page, 'Vera Viewer');

    // What she may do: per scope, each capability in words, with its reason.
    const does = page.getByRole('region', { name: 'Was Vera Viewer tun darf' });
    await expect(does.getByRole('rowheader', { name: 'Projekt Employee Portal' })).toBeVisible();
    await expect(does.getByText('Veröffentlichte Dashboards ansehen')).toBeVisible();
    await expect(does.getByText('Rolle Viewer').first()).toBeVisible();

    // Which data: a yes names its reasons, a no names the missing half.
    const data = page.getByRole('region', { name: 'Welche Daten Vera Viewer sehen darf' });
    const row = data.getByRole('row', { name: /Portal Overview/ });
    await expect(row.getByText('Ja', { exact: false }).first()).toBeVisible();
    await expect(row.getByText(/Nein - .*fehl/)).toBeVisible();

    await row.getByText(/Gründe? anzeigen/).click();
    await expect(row.getByText('Gruppe Portal-Leser')).toBeVisible();
    await expect(row.getByText(/Freigabe für Projekt Employee Portal \(Ansehen\)/)).toBeVisible();
  });

  test('shows who can open a dashboard, and why', async ({ page }) => {
    await page.goto('/admin/access?view=objects');
    await page
      .getByRole('link', { name: /Portal Overview/ })
      .first()
      .click();

    const table = page.getByRole('table', { name: 'Wer hat Zugriff auf Portal Overview?' });
    await expect(table.getByRole('row', { name: /Erik Editor/ })).toContainText('Ja');
    // Nobody is listed for a role alone: the Tenant Admin has no data here.
    await expect(table.getByRole('row', { name: /Tom Tenantadmin/ })).toHaveCount(0);
  });

  test('previews a change first, and says so when it would change nothing', async ({ page }) => {
    await openPerson(page, 'Vera Viewer');

    // Vera already sees the project through her group; granting it to her
    // directly changes nothing, and the preview says exactly that.
    const grants = page.getByRole('region', { name: 'Freigaben', exact: true });
    await grants
      .getByLabel('Dashboard oder Projekt')
      .selectOption({ label: 'Projekt: Employee Portal' });
    await grants.getByLabel('Zugriff').selectOption('view');
    await grants.getByRole('button', { name: 'Freigabe erteilen: Auswirkung prüfen' }).click();

    await expect(grants.getByText('Keine Auswirkung')).toBeVisible();
    await grants.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(grants.getByText('Keine Auswirkung')).toHaveCount(0);
  });

  test('never offers Platform Admin to a Tenant Admin', async ({ page }) => {
    await openPerson(page, 'Erik Editor');

    const roles = page.getByRole('region', { name: 'Rollen', exact: true });
    const offered = await roles.getByLabel('Rolle').locator('option').allTextContents();
    expect(offered).not.toContain('Platform Admin');
    expect(offered.length).toBeGreaterThan(0);
  });

  test('reflows on a phone without horizontal scrolling', async ({ page }) => {
    await openPerson(page, 'Vera Viewer');
    await expect(page.getByRole('heading', { name: 'Effective Access' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('administration: self service', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('shows my own profile and my own effective access', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Mein Profil' })).toBeVisible();
    await expect(page.getByLabel('Vorname')).toBeEditable();
    // The address is changed in its own, verified flow - not in this form.
    await expect(page.getByLabel('E-Mail-Adresse', { exact: true })).not.toBeEditable();
    await expect(page.getByRole('heading', { name: 'E-Mail-Adresse ändern' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Passwort ändern' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Meine Rechte' })).toBeVisible();
    await expect(page.getByText('Veröffentlichte Dashboards ansehen').first()).toBeVisible();
  });

  test('offers no administration it does not allow', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText('Keine Administrationsrechte')).toBeVisible();
  });
});

test.describe('administration: tenants', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: PLATFORM_ADMIN_STATE });
  test.describe.configure({ mode: 'serial' });

  let invitation = '';
  let tenantUrl = '';

  test('a Platform Admin sees no customer analytics', async ({ page }) => {
    await page.goto('/dashboards');
    await expect(page.getByRole('link', { name: 'Portal Overview' })).toHaveCount(0);

    await page.goto('/admin/tenants');
    await page.getByRole('link', { name: 'Corporate Communications Demo' }).click();
    await expect(page.getByText(/sehen aber keine seiner Daten/)).toBeVisible();
  });

  test('creates a tenant through the wizard', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await page.goto('/admin/tenants');
    await page.getByRole('link', { name: 'Tenant anlegen' }).click();

    await page.getByRole('textbox', { name: 'Name des Kunden' }).fill(TENANT);
    await expect(page.getByRole('textbox', { name: 'Kürzel', exact: true })).toHaveValue(
      `gate-f5-kunde-${RUN}`,
    );
    await page.getByRole('button', { name: 'Weiter' }).click();

    // Focus follows to the new step, so a keyboard user lands on it.
    await expect(page.getByRole('heading', { name: 'Erster Administrator' })).toBeFocused();
    await page.getByLabel('E-Mail-Adresse').fill(`gate.f5.${RUN}@example.invalid`);
    await page.getByLabel('Vorname').fill('Gerda');
    await page.getByLabel('Nachname').fill('Gate');
    await page.getByRole('button', { name: 'Weiter' }).click();

    await page.getByLabel('Name des Projekts').fill('Webshop');
    await page.getByRole('button', { name: 'Weiter' }).click();

    // Nothing is created before the review; the review states the access model.
    await expect(page.getByText(/sieht aber Daten erst mit einer Freigabe/)).toBeVisible();
    await page.getByRole('button', { name: 'Kunden anlegen' }).click();

    await expect(page.getByText('Kunde angelegt')).toBeVisible();
    invitation = await page.getByLabel('Einladungslink').inputValue();
    expect(invitation).toContain('/invite?token=');

    await page.getByRole('link', { name: 'Zum Kunden' }).click();
    await expect(page.getByText('Zustand: Wird eingerichtet').first()).toBeVisible();
    tenantUrl = page.url();
  });

  test('changes the lifecycle behind a typed confirmation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await page.goto(`${tenantUrl}?tab=lifecycle`);
    await page.getByRole('link', { name: 'Wechseln zu: Aktiv' }).click();

    await expect(page.getByRole('heading', { name: 'Auswirkung' })).toBeVisible();
    const apply = page.getByRole('button', { name: 'Zustand ändern: Aktiv' });
    await expect(apply).toBeDisabled();

    await page.getByLabel(/Zur Bestätigung den Namen eintippen/).fill(TENANT);
    await apply.click();

    // A session older than the re-authentication window is asked again.
    const done = page.getByText('Der Zustand ist jetzt: Aktiv.');
    const password = page.getByLabel('Ihr Passwort');
    await expect(done.or(password)).toBeVisible();
    if (await password.isVisible()) {
      await password.fill(VIEWER_PASSWORD);
      await apply.click();
    }

    await expect(done).toBeVisible();
  });

  test('an invitation link works exactly once', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    // A fresh browser: the invited person is nobody's session.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto(invitation);
    await expect(page.getByRole('heading', { name: 'Willkommen, Gerda' })).toBeVisible();
    await page.getByLabel(/^Passwort\*?$/).fill(VIEWER_PASSWORD);
    await page.getByLabel(/^Passwort wiederholen/).fill(VIEWER_PASSWORD);
    await page.getByRole('button', { name: 'Konto aktivieren' }).click();
    await expect(page.getByText('Konto aktiviert')).toBeVisible();

    await page.goto(invitation);
    await expect(page.getByText('Dieser Einladungslink gilt nicht')).toBeVisible();
    await context.close();
  });
});

async function openPerson(page: Page, name: string): Promise<void> {
  await page.goto('/admin/users');
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}
