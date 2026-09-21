import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_SKIP_REASON,
  PROJECT_NAME,
  SEMANTIC_STATE,
  VIEWER_EMAIL,
  VIEWER_STATE,
} from './session';

/**
 * Phase 3 semantic journey (D6, Gate F3).
 *
 * What only a browser can show: that the formula builder is a tree of controls
 * rather than an expression field, that a formula which cannot combine is
 * refused with a readable reason, that a score states its own rule about
 * missing inputs, and that correcting a mapping does not produce a new
 * definition version.
 *
 * Runs as the semantic catalog manager, since the catalog is an authoring
 * surface.
 */

const RUN = Date.now().toString(36);
const FORMULA = `Seiten pro Besuch ${RUN}`;
const SCORE = `Portal Score ${RUN}`;

test.describe('semantic catalog', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: SEMANTIC_STATE });
  test.describe.configure({ mode: 'serial' });

  test('opens from the project and lists what the numbers mean', async ({ page }) => {
    await openCatalog(page);

    await expect(page.getByRole('heading', { name: 'Semantik' })).toBeVisible();
    // The seeded native metrics, with their meaning stated rather than implied.
    await expect(page.getByRole('cell', { name: /Direkt aus Matomo: visits/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: /Aktiv in Version 1/ }).first()).toBeVisible();
  });

  test('builds a formula from controls, with no expression field anywhere', async ({ page }) => {
    await openCatalog(page);

    const panel = page.getByRole('region', { name: 'Neue Definition' });
    await panel.getByLabel('Name').fill(FORMULA);
    await panel.getByLabel('Typ').selectOption('formula');

    // A tree of selects. Nothing here accepts an expression, which is the same
    // reason the stored AST has no string to interpret (Gate F3).
    await expect(panel.getByLabel('Baustein').first()).toBeVisible();
    await expect(panel.getByLabel('Rechenart')).toBeVisible();

    const left = panel.getByRole('group', { name: 'Links' });
    const right = panel.getByRole('group', { name: 'Rechts' });
    await left.getByLabel('Kennzahl').selectOption({ label: 'Seitenaufrufe' });
    await right.getByLabel('Kennzahl').selectOption({ label: 'Besuche' });
    await panel.getByLabel('Rechenart').selectOption('/');

    await panel.getByRole('button', { name: 'Vorschau berechnen' }).click();

    // The preview shows a number and how it came about.
    const preview = page.getByRole('region', { name: 'Vorschau' });
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview.getByText('Seitenaufrufe')).toBeVisible();

    await panel.getByRole('button', { name: 'Als Entwurf speichern' }).click();
    await expect(page.getByText(/Als Entwurf gespeichert/)).toBeVisible({ timeout: 20_000 });
  });

  test('refuses a formula that cannot combine, and says why', async ({ page }) => {
    await openCatalog(page);

    const panel = page.getByRole('region', { name: 'Neue Definition' });
    await panel.getByLabel('Name').fill(`Unsinn ${RUN}`);
    await panel.getByLabel('Typ').selectOption('formula');
    await panel.getByLabel('Rechenart').selectOption('*');

    const left = panel.getByRole('group', { name: 'Links' });
    const right = panel.getByRole('group', { name: 'Rechts' });
    await left.getByLabel('Kennzahl').selectOption({ label: 'Besuche' });
    await right.getByLabel('Kennzahl').selectOption({ label: 'Seitenaufrufe' });

    await panel.getByRole('button', { name: 'Als Entwurf speichern' }).click();

    // Not a generic failure: the reason names what does not combine (D10).
    await expect(page.getByText(/lassen sich nicht/)).toBeVisible({ timeout: 20_000 });
  });

  test('states the score rule about missing inputs on the builder itself', async ({ page }) => {
    await openCatalog(page);

    const panel = page.getByRole('region', { name: 'Neue Definition' });
    await panel.getByLabel('Name').fill(SCORE);
    await panel.getByLabel('Typ').selectOption('score');

    // The rule is on the screen, not buried in documentation (Gate F3).
    await expect(panel.getByText('Alle Bestandteile sind erforderlich')).toBeVisible();
    await expect(panel.getByText(/nicht stillschweigend umverteilt/)).toBeVisible();

    // Weights are shown as the share of the whole they actually are.
    await expect(panel.getByRole('group', { name: /Bestandteil 1 · 100 %/ })).toBeVisible();

    await panel.getByRole('button', { name: 'Bestandteil hinzufügen' }).click();
    await expect(panel.getByRole('group', { name: /Bestandteil 2/ })).toBeVisible();
  });

  test('says what a number means and where it is used', async ({ page }) => {
    await openCatalog(page);
    await page.getByRole('button', { name: 'Besuche', exact: true }).click();

    // The glossary entry: the meaning in words, not the formula.
    await expect(page.getByText(/zusammenhängende Folge von Aufrufen/)).toBeVisible();

    // And where it is used, with published and draft named apart - a published
    // dashboard holds the version it pinned, a draft does not (Gate F3).
    await expect(page.getByRole('columnheader', { name: 'Verwendung' })).toBeVisible();
    await expect(page.getByText(/veröffentlichte?s? Dashboard/).first()).toBeVisible();
  });

  test('shows version history only when asked', async ({ page }) => {
    await openCatalog(page);

    // The usual question is what a number means now, not how it got there.
    await expect(page.getByRole('button', { name: 'Versionsverlauf anzeigen' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Besuche', exact: true }).click();
    await page.getByRole('button', { name: 'Versionsverlauf anzeigen' }).click();

    // Scoped to the history itself: "Version 1" also appears in the table's
    // "Aktiv in Version 1", which is a different statement.
    const history = page.getByRole('list', { name: 'Versionsverlauf' });
    await expect(history.getByText('Version 1')).toBeVisible({ timeout: 20_000 });
  });

  test('records a mapping without creating a definition version', async ({ page }) => {
    await openCatalog(page);

    // `count()` does not wait, so the table has to be on the page first -
    // otherwise "before" is zero and the assertion below proves nothing.
    const active = page.getByRole('cell', { name: /Aktiv in Version/ });
    await expect(active.first()).toBeVisible();
    const before = await active.count();
    expect(before).toBeGreaterThan(0);

    const mappings = page.getByRole('region', { name: 'Quell-Zuordnungen' });
    await mappings.getByLabel('Anforderung').fill(`pulse.engaged_users_${RUN}`);
    await mappings.getByLabel('Quelle').selectOption('custom_dimension');
    await mappings.getByLabel('Index der Dimension').fill('3');
    await mappings.getByRole('button', { name: 'Zuordnung speichern' }).click();

    await expect(page.getByText('Die Zuordnung wurde gespeichert.')).toBeVisible({
      timeout: 20_000,
    });

    // Correcting the wiring is a technical fix; the business definitions are
    // exactly as they were (Gate F3).
    await page.reload();
    await expect(active).toHaveCount(before);
    await expect(mappings.getByText(`pulse.engaged_users_${RUN}`)).toBeVisible();
  });

  test('keeps the catalog away from a plain viewer', async ({ browser }) => {
    // A viewer sees the definition behind a number on a dashboard; the catalog
    // is a different question with a different answer (Master Spec §7).
    const context = await browser.newContext({ storageState: VIEWER_STATE });
    const page = await context.newPage();

    await page.goto('/projects');
    await page.getByRole('link', { name: PROJECT_NAME }).first().click();
    await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();

    await expect(page.getByRole('link', { name: 'Katalog öffnen' })).toHaveCount(0);

    await page.goto(`${new URL(page.url()).pathname}/semantics`);
    await expect(page.getByText('Kein Zugriff auf den Kennzahlen-Katalog')).toBeVisible();

    await context.close();
  });
});

async function openCatalog(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.getByRole('link', { name: PROJECT_NAME }).first().click();
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();

  await page.getByRole('link', { name: 'Katalog öffnen' }).click();
  await expect(page.getByRole('heading', { name: 'Semantik' })).toBeVisible();
}
