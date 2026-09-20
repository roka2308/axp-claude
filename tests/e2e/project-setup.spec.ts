import { expect, test, type Page } from '@playwright/test';
import {
  DEMO_MATOMO_TOKEN,
  EDITOR_STATE,
  FIXTURE_SKIP_REASON,
  PROJECT_NAME,
  TENANT_ADMIN_STATE,
  uniqueName,
  VIEWER_EMAIL,
} from './session';

/**
 * Phase 1 setup journey.
 *
 * Connect Matomo → see what it can do → assign a site → create a dashboard →
 * publish it (Master Spec §13, §21, §27).
 *
 * Deliberately split across two roles, because the roles are additive and not
 * hierarchical: a tenant administrator connects Matomo and assigns the site, a
 * dashboard editor creates and publishes the dashboard. Neither can do the
 * other's step, and the page has to say so rather than show an empty section
 * (Master Spec §7, D10).
 *
 * The journey writes real rows into the demo fixture, so every name it creates
 * is unique per run.
 */

const MOCK_MATOMO_URL = 'mock://default';
const LIMITED_MATOMO_URL = 'mock://limited';

test.describe('setup as a tenant administrator', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: TENANT_ADMIN_STATE });

  test('reaches setup from the project and sees what Matomo can do', async ({ page }) => {
    await openProject(page);

    await page.getByRole('link', { name: 'Einrichtung fortsetzen' }).first().click();
    await expect(page.getByRole('heading', { name: 'Projekt einrichten' })).toBeVisible();

    // The compatibility conclusion is text, with the version beside it rather
    // than instead of it (G3). `.first()` because the fixture accumulates
    // connections across runs and every one of them reports its own state.
    await expect(page.getByText(/Kompatibilität: Unterstützt/).first()).toBeVisible();
    await expect(page.getByText(/Matomo-Version \d/).first()).toBeVisible();

    // And the probes behind the conclusion are inspectable.
    await page.getByText('Geprüfte Funktionen').first().click();
    await expect(page.getByText('Kernfunktionen').first()).toBeVisible();
    await expect(page.getByText('Besuche', { exact: true }).first()).toBeVisible();
  });

  test('tests a connection before storing it', async ({ page }) => {
    await openSetup(page);

    await page.getByLabel('Bezeichnung').fill(uniqueName('Test nur'));
    await page.getByLabel('Matomo-Adresse').fill(LIMITED_MATOMO_URL);
    await page.getByLabel('API-Token (token_auth)').fill(DEMO_MATOMO_TOKEN);
    await page.getByRole('button', { name: 'Verbindung testen' }).click();

    // A limitation is reported as a limitation, not as a failure.
    await expect(
      page.getByText(/Kompatibilität: Unterstützt mit Einschränkungen/).first(),
    ).toBeVisible();
    await expect(page.getByText('Einschränkungen').first()).toBeVisible();
  });

  test('reports an unusable address without storing anything', async ({ page }) => {
    await openSetup(page);
    const before = await connectionCount(page);

    await page.getByLabel('Bezeichnung').fill(uniqueName('Kaputt'));
    await page.getByLabel('Matomo-Adresse').fill('mock://unavailable');
    await page.getByLabel('API-Token (token_auth)').fill(DEMO_MATOMO_TOKEN);
    await page.getByRole('button', { name: 'Verbindung testen' }).click();

    await expect(page.getByText(/Kompatibilität: Nicht unterstützt/).first()).toBeVisible();

    await page.reload();
    expect(await connectionCount(page)).toBe(before);
  });

  test('stores a connection and assigns one of its sites', async ({ page }) => {
    await openSetup(page);
    const name = uniqueName('Matomo E2E');

    await page.getByLabel('Bezeichnung').fill(name);
    await page.getByLabel('Matomo-Adresse').fill(MOCK_MATOMO_URL);
    await page.getByLabel('API-Token (token_auth)').fill(DEMO_MATOMO_TOKEN);
    await page.getByRole('button', { name: 'Verbindung speichern' }).click();

    await expect(page.getByText('Die Verbindung wurde angelegt und geprüft.')).toBeVisible();

    // The credential never comes back, in any form.
    const html = await page.content();
    expect(html).not.toContain(DEMO_MATOMO_TOKEN);
    expect(html).not.toMatch(/token_auth=/i);

    await page.reload();
    // The stored connection, not the site option that also mentions its name.
    await expect(page.getByRole('strong').filter({ hasText: name })).toBeVisible();

    // Assign the site this new connection reports. Its time zone is on the
    // option, because the time zone decides what a day is.
    const option = page.getByLabel('Verfügbare Sites').locator('option', { hasText: name }).first();
    await expect(option).toHaveText(/Europe\/Berlin/);

    await page.getByLabel('Verfügbare Sites').selectOption({ label: await option.innerText() });
    await page.getByRole('button', { name: 'Site zuordnen' }).click();

    await expect(page.getByText('Die Site wurde dem Projekt zugeordnet.')).toBeVisible();
  });

  test('is told which steps belong to another role', async ({ page }) => {
    await openSetup(page);

    // Creating dashboards is the editor's capability, and a tenant admin does
    // not inherit it. The section says so instead of failing on submit.
    const section = page.getByRole('region', { name: 'Erstes Dashboard' });
    await expect(section.getByText('Für diesen Schritt nicht berechtigt')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Dashboard anlegen' })).toHaveCount(0);
  });
});

test.describe('setup as a dashboard editor', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: EDITOR_STATE });

  test('is told that connecting Matomo belongs to another role', async ({ page }) => {
    await openSetup(page);

    const section = page.getByRole('region', { name: 'Matomo-Verbindung' });
    await expect(section.getByText('Für diesen Schritt nicht berechtigt')).toBeVisible();
    await expect(section.getByLabel('API-Token (token_auth)')).toHaveCount(0);
  });

  test('creates a dashboard and publishes it', async ({ page }) => {
    await openSetup(page);
    const name = uniqueName('E2E Dashboard');

    const section = page.getByRole('region', { name: 'Erstes Dashboard' });
    await section.getByLabel('Name').fill(name);
    await section.getByLabel('Beschreibung').fill('Angelegt durch den E2E-Test.');
    await section.getByRole('button', { name: 'Dashboard anlegen' }).click();

    await expect(
      page.getByText(`Das Dashboard „${name}“ wurde als Entwurf angelegt.`),
    ).toBeVisible();

    // A new dashboard is a draft: nobody sees it until it is published.
    await openProject(page);
    const row = page.getByRole('listitem').filter({ hasText: name });
    await expect(row.getByText('Noch nicht veröffentlicht')).toBeVisible();

    await row.getByRole('button', { name: 'Veröffentlichen' }).click();
    await expect(row.getByText(/Veröffentlicht in Version 1/)).toBeVisible();

    // And it renders - empty, because widgets arrive with the editor.
    await row.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText('Dieses Dashboard enthält noch keine Widgets')).toBeVisible();
  });
});

// --- helpers ---------------------------------------------------------------

async function openProject(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.getByRole('link', { name: PROJECT_NAME }).first().click();
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();
}

async function openSetup(page: Page): Promise<void> {
  await openProject(page);
  await page.goto(`${new URL(page.url()).pathname}/setup`);
  await expect(page.getByRole('heading', { name: 'Projekt einrichten' })).toBeVisible();
}

async function connectionCount(page: Page): Promise<number> {
  return page.getByRole('button', { name: 'Funktionsumfang neu prüfen' }).count();
}
