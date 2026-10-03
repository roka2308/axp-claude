import { expect, test, type Page } from '@playwright/test';
import {
  EDITOR_STATE,
  FIXTURE_SKIP_REASON,
  PROJECT_NAME,
  VIEWER_EMAIL,
  VIEWER_STATE,
} from './session';

/**
 * Phase 8: scheduled reports and the Attention Center (D8, Gate F8).
 *
 * What only a browser shows: planning a report in words a person understands,
 * the recipients the dashboard actually allows, "send now" going through the
 * real worker, and the run history saying what was sent and for which period.
 */

const RUN = Date.now().toString(36);
test.describe.configure({ timeout: 120_000 });

async function openProject(page: Page) {
  await page.goto('/projects');
  await page.getByRole('link', { name: PROJECT_NAME }).first().click();
  await page.waitForURL(/\/projects\/[^/?]+$/);
}

test.describe('scheduled reports', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: EDITOR_STATE });

  test('plans a report, sends it now, and shows the run', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Authoring is desktop-first.');
    await openProject(page);
    await page.getByRole('link', { name: 'Reports öffnen' }).click();
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();

    const name = `Wochenbericht ${RUN}`;
    await page.getByLabel(/^Dashboard/).selectOption({ label: 'Executive Health Overview' });
    await page.getByRole('textbox', { name: 'Bezeichnung' }).fill(name);
    await page.getByLabel('Rhythmus', { exact: true }).selectOption('weekly');
    await page.getByLabel('Wochentag', { exact: true }).selectOption('1');
    // PowerPoint waits for its stability gate, and says so.
    await expect(page.getByText(/PowerPoint folgt für geplante Berichte/)).toBeVisible();

    // Only people who may see the dashboard can be ticked.
    const recipients = page.getByRole('group', { name: 'An wen' });
    await expect(recipients.getByRole('checkbox').first()).toBeVisible();
    const viewerBox = page.getByLabel(/^Vera Viewer/);
    await viewerBox.check();

    await page.getByRole('button', { name: 'Bericht planen' }).click();
    const card = page.getByRole('listitem', { name });
    await expect(card.getByText('Aktiv')).toBeVisible();
    await expect(card.getByText(/^Jeden Montag um 07:00 \(Europe\/Berlin\)$/)).toBeVisible();

    await card.getByRole('button', { name: 'Jetzt senden' }).click();
    await expect(card.getByText('Der Versand ist eingeplant und läuft in Kürze.')).toBeVisible();

    // The worker picks it up from the queue within a few seconds.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('listitem', { name }).getByText(/^Zugestellt · /)).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 60_000 });

    await page.getByRole('listitem', { name }).getByRole('link', { name: 'Verlauf' }).click();
    const history = page.getByRole('table');
    await expect(history.getByRole('cell', { name: 'Manuell', exact: true })).toBeVisible();
    await expect(history.getByRole('cell', { name: 'Zugestellt', exact: true })).toBeVisible();
  });

  test('the reports page reflows on a phone', async ({ page }) => {
    await openProject(page);
    await page.getByRole('link', { name: 'Reports öffnen' }).click();
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('reports are not offered to viewers', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: VIEWER_STATE });

  test('no reports entry on the project page', async ({ page }) => {
    await openProject(page);
    await expect(page.getByRole('link', { name: 'Reports öffnen' })).toHaveCount(0);
  });
});

test.describe('attention center', () => {
  test.skip(!VIEWER_EMAIL, FIXTURE_SKIP_REASON);
  test.use({ storageState: EDITOR_STATE });

  test('is reachable from the top bar and says what it is for', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Aufmerksamkeit/ }).click();
    await expect(page.getByRole('heading', { name: 'Aufmerksamkeit', level: 1 })).toBeVisible();
    await expect(page.getByText(/Hier erscheinen nur betriebliche Hinweise/)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
