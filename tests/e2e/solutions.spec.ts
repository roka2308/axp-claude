import { expect, test, type Page } from '@playwright/test';
import {
  EDITOR_STATE,
  FIXTURE_SKIP_REASON,
  PROJECT_NAME,
  SEMANTIC_STATE,
  TENANT_ADMIN_STATE,
  VIEWER_EMAIL,
  VIEWER_STATE,
} from './session';

/**
 * Phase 6: project setup, templates and the Pulse reference solution (D6,
 * D7, Gate F6).
 *
 * What only a browser shows: the canonical Pulse values on the reference
 * dashboard with the evaluation in words, the install flow step by step, an
 * upload refused with its reasons, a dashboard created from a template, and
 * the four-step project creation ending on the setup checklist.
 */

const RUN = Date.now().toString(36);

async function openTemplates(page: Page, tab: 'dashboards' | 'widgets' | 'solutions') {
  await page.goto(`/templates?tab=${tab}`);
  const picker = page.getByLabel('Projekt', { exact: true });
  if (await picker.isVisible().catch(() => false)) {
    await picker.selectOption({ label: PROJECT_NAME });
    await page.getByRole('button', { name: 'Wechseln' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Vorlagen', level: 1 })).toBeVisible();
}

test.describe('Pulse reference solution: values', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('shows the canonical Pulse values, with the evaluation in words', async ({ page }) => {
    await page.goto('/dashboards');
    await page.getByRole('link', { name: 'Executive Health Overview' }).click();

    // The template's own default period: the last 7 days.
    await expect(page.getByText(/^Zeitraum: /)).toBeVisible();
    await expect(page.getByLabel('Zeitraum', { exact: true })).toHaveValue('last_7_days');

    const tile = (title: string) => page.getByRole('region', { name: title, exact: true });
    await expect(tile('PULSE').getByText('40,32')).toBeVisible();
    await expect(tile('PULSE').getByText('Bewertung: solide')).toBeVisible();
    await expect(tile('Interaction Index').getByText('15,4', { exact: true })).toBeVisible();
    await expect(tile('Adoption Rate').getByText('51 %', { exact: true })).toBeVisible();
    await expect(tile('Engagement Rate').getByText('18 %', { exact: true })).toBeVisible();
    await expect(tile('Creation Rate').getByText('5 %', { exact: true })).toBeVisible();
  });
});

test.describe('solutions: install flow', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: SEMANTIC_STATE });

  test('walks through check, mapping, conflicts and preview without surprises', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await openTemplates(page, 'solutions');

    const pulse = page.getByRole('region', { name: 'Employee Portal Health (Pulse)', exact: true });
    await expect(pulse.getByText('Installiert: Version 1.0.0')).toBeVisible();
    await pulse.getByRole('link', { name: 'Prüfen und aktualisieren' }).click();

    await expect(
      page.getByText('Die Lösung ist gültig und passt zu diesem Projekt.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();

    // Focus follows the step; the four requirements are already mapped.
    await expect(page.getByRole('heading', { name: 'Datenquellen zuordnen' })).toBeFocused();
    await expect(page.getByText(/^Bereits zugeordnet:/)).toHaveCount(4);
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(
      page.getByText('Keine Konflikte: Nichts im Projekt wird überschrieben.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(
      page.getByText('Bestehende Dashboards bleiben unverändert.', { exact: false }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Lösung aktualisieren' }).click();

    await expect(page.getByRole('heading', { name: 'Installiert' })).toBeVisible();
    await expect(page.getByText(/0 neu angelegt, 9 wiederverwendet/)).toBeVisible();
  });

  test('refuses an uploaded package that carries code, and says why', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await openTemplates(page, 'solutions');
    await page.getByRole('link', { name: 'Lösung aus Datei installieren' }).click();

    const malicious = {
      manifest: { packageId: 'com.evil.pkg', script: 'fetch("https://evil.example")' },
    };
    await page.getByLabel('Datei auswählen').setInputFiles({
      name: 'evil.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(malicious)),
    });

    await expect(page.getByText('Die Lösung kann so nicht installiert werden.')).toBeVisible();
    await expect(
      page.getByText(/Felder, die eine Lösung nicht enthalten darf/).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Weiter' })).toBeDisabled();
  });

  test('reflows the solutions page on a phone', async ({ page }) => {
    await openTemplates(page, 'solutions');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('templates: a dashboard from a template', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: EDITOR_STATE });

  test('creates a dashboard as a copy and opens it in the editor', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await openTemplates(page, 'dashboards');

    const card = page.getByRole('region', {
      name: 'Engagement & Participation Detail',
      exact: true,
    });
    await expect(card.getByText('Bereit')).toBeVisible();
    await card.getByRole('button', { name: 'Dashboard aus Vorlage erstellen' }).click();

    const name = `Engagement ${RUN}`;
    await card.getByLabel('Name des neuen Dashboards').fill(name);
    await expect(card.getByText(/Das Dashboard ist eine Kopie/)).toBeVisible();
    await card.getByRole('button', { name: 'Erstellen und bearbeiten' }).click();

    await expect(page).toHaveURL(/\/dashboards\/[^/]+\/edit$/);
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  });
});

test.describe('project creation and setup', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: TENANT_ADMIN_STATE });

  test('creates a project in four steps and lands on its checklist', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await page.goto('/projects');
    await page.getByRole('link', { name: 'Projekt anlegen' }).click();

    await page.getByRole('textbox', { name: 'Name des Projekts' }).fill(`Standort ${RUN}`);
    await expect(page.getByRole('textbox', { name: 'Kürzel', exact: true })).toHaveValue(
      `standort-${RUN}`,
    );
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(page.getByRole('heading', { name: 'Kontext' })).toBeFocused();
    await page.getByRole('textbox', { name: 'Anwendungsfall' }).fill('Standort beobachten');
    await page.getByRole('textbox', { name: 'Zielgruppe' }).fill('Standortleitung');
    await page.getByRole('button', { name: 'Weiter' }).click();

    // Reuse: the tenant already has a site, so that is offered first.
    await expect(page.getByLabel('Eine Site, die der Kunde schon nutzt')).toBeChecked();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByRole('button', { name: 'Projekt anlegen' }).click();

    await expect(page).toHaveURL(/\/projects\/[^/]+\/setup$/);
    const step = (name: string) => page.getByRole('listitem').filter({ hasText: name });
    await expect(step('Site dem Projekt zuordnen')).toContainText('Fertig');
    await expect(step('Datenquellen zuordnen')).toContainText('Nicht relevant');
    await expect(step('Erstes Dashboard veröffentlichen')).toContainText('Offen');
    await expect(step('Kontextprofil hinterlegen')).toContainText('Fertig');
  });

  test('marks an optional step not relevant, and takes it back', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await page.goto('/projects');
    await page.getByRole('link', { name: PROJECT_NAME }).first().click();
    await page.waitForURL(/\/projects\/[^/?]+$/);
    await page.goto(`${page.url()}/setup`);

    const reporting = page.getByRole('listitem').filter({ hasText: 'Reporting einrichten' });
    await reporting.getByRole('button', { name: 'Als nicht relevant markieren' }).click();
    await expect(reporting).toContainText('Nicht relevant');
    await reporting.getByRole('button', { name: 'Doch relevant' }).click();
    await expect(reporting).toContainText('Offen');
  });
});
