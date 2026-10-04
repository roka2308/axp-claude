import { expect, test } from '@playwright/test';
import {
  DASHBOARD_NAME,
  DEMO_MATOMO_TOKEN,
  EDITOR_STATE,
  FIXTURE_SKIP_REASON,
  PLATFORM_ADMIN_STATE,
  TENANT_ADMIN_STATE,
  VIEWER_EMAIL,
  VIEWER_PASSWORD,
  VIEWER_STATE,
} from './session';

/**
 * Phase 9: themes, entitlements, release metadata and diagnostics (D9, Gate F9).
 *
 * What only a browser shows: the published theme actually reaching the page,
 * a theme that fails contrast being refused at the button rather than after
 * the fact, a module switched off surfacing as an entitlement (not as a
 * permission error) and the diagnostic bundle being something an operator can
 * hand to support without leaking anything.
 */

const TENANT_NAME = 'Corporate Communications Demo';
test.describe.configure({ timeout: 120_000 });

test.describe('themes', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);

  test.describe('applied', () => {
    test.use({ storageState: VIEWER_STATE });

    test('the published theme reaches the page as tokens only', async ({ page }) => {
      await page.goto('/dashboards');
      const style = page.locator('style[data-axp-theme]');
      await expect(style.first()).toBeAttached();
      const css = (await style.allTextContents()).join('\n');
      expect(css).toContain('--accent-default:');
      // Only custom properties, no selectors that could restyle arbitrary markup.
      expect(css).not.toMatch(/url\(|@import|expression\(|<\/style/i);
    });
  });

  test.describe('editing', () => {
    test.use({ storageState: TENANT_ADMIN_STATE });

    test('a theme that fails contrast cannot be published', async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
      await page.goto('/admin/themes');
      await expect(
        page.getByRole('heading', { name: `Theme bearbeiten: ${TENANT_NAME}` }),
      ).toBeVisible();
      await expect(page.getByText(/^Veröffentlicht: Version \d+$/)).toBeVisible();

      // White button labels on yellow: the button-label pair fails 4.5:1.
      const accent = page.locator('[id="light---accent-default"]');
      await accent.fill('#ffff00');
      await expect(page.getByText('Ungespeicherte Änderungen')).toBeVisible();
      await page.getByRole('button', { name: 'Entwurf speichern' }).click();
      await expect(page.getByText('Entwurf gespeichert.')).toBeVisible();

      await page.getByRole('button', { name: 'Prüfen' }).click();
      await expect(page.getByRole('heading', { name: /^Nicht veröffentlichbar/ })).toBeVisible();
      const failing = page.getByRole('row').filter({ hasText: 'Schrift auf Schaltfläche' });
      await expect(failing.first().getByRole('cell', { name: 'Nicht bestanden' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Veröffentlichen' })).toBeDisabled();

      await page.getByRole('button', { name: 'Entwurf verwerfen' }).click();
      await expect(page.getByText('Entwurf verworfen.')).toBeVisible();
      await expect(page.getByText('Kein Entwurf')).toBeVisible();
    });

    test('the themes page reflows on a phone', async ({ page }) => {
      await page.goto('/admin/themes');
      await expect(page.getByRole('heading', { name: 'Themes', level: 2 })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});

test.describe('entitlements and system', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: PLATFORM_ADMIN_STATE });
  test.describe.configure({ mode: 'serial' });

  test('switching a module off is an entitlement, and deletes nothing', async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await page.goto('/admin/tenants');
    await page.getByRole('link', { name: TENANT_NAME }).click();
    await page.getByRole('link', { name: 'Entitlements' }).click();

    const external = page.getByRole('listitem', { name: 'Externe Links' });
    await expect(external.getByText('Freigeschaltet', { exact: true })).toBeVisible();
    await external.getByRole('button', { name: 'Abschalten' }).click();
    await expect(external.getByText('Nicht freigeschaltet', { exact: true })).toBeVisible();

    const editorContext = await browser.newContext({ storageState: EDITOR_STATE });
    try {
      const editor = await editorContext.newPage();
      await editor.goto('/dashboards');
      await editor.getByRole('link', { name: DASHBOARD_NAME }).first().click();
      await editor.waitForURL(/\/dashboards\/[^/?]+$/);
      await editor.goto(`${new URL(editor.url()).pathname}/share`);
      await expect(editor.getByText('Externe Links sind nicht freigeschaltet')).toBeVisible();
      // Not a permission error: the rest of the page is still there.
      await expect(editor.getByRole('heading', { name: 'Externer Link', level: 2 })).toBeVisible();
    } finally {
      await editorContext.close();
      await external.getByRole('button', { name: 'Freischalten' }).click();
      await expect(external.getByText('Freigeschaltet', { exact: true })).toBeVisible();
    }
  });

  test('shows release metadata and hands out a clean diagnostic bundle', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await page.goto('/admin/system');
    await expect(page.getByRole('heading', { name: 'System', level: 2 })).toBeVisible();
    await expect(page.getByText('Schemaversion', { exact: true })).toBeVisible();
    await expect(page.getByText('Supportstatus', { exact: true })).toBeVisible();

    const generate = page.getByRole('button', { name: 'Diagnosepaket erstellen' });
    await generate.click();
    const ready = page.getByText('Diagnosepaket bereit');
    const password = page.getByLabel('Passwort', { exact: true });
    await expect(ready.or(password)).toBeVisible();
    if (await password.isVisible()) {
      await password.fill(VIEWER_PASSWORD);
      await generate.click();
    }
    await expect(ready).toBeVisible();

    const href = await page.getByRole('link', { name: /herunterladen$/ }).getAttribute('href');
    expect(href).toBeTruthy();
    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    const body = await response.text();
    const bundle = JSON.parse(body) as Record<string, unknown>;
    expect(bundle).toHaveProperty('release');
    expect(body).not.toContain(DEMO_MATOMO_TOKEN);
    expect(body).not.toContain(VIEWER_PASSWORD);
    expect(body).not.toMatch(/@example\.invalid/);
  });

  test('a tenant administrator gets no system page', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    const context = await browser.newContext({ storageState: TENANT_ADMIN_STATE });
    try {
      const page = await context.newPage();
      await page.goto('/admin/system');
      await expect(page.getByText(/Plattform-Administration vorbehalten/)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
