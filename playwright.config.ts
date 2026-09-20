import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

/**
 * End-to-end acceptance.
 *
 * Phase 0 covers the bootstrap and sign-in journey plus the accessibility
 * smoke checks Gate F0 asks for; Phase 1 adds the dashboard viewer journey.
 * The remaining D10 journeys are added as their milestones land; the browser
 * matrix widens in Phase 10.
 *
 * The `setup` project signs in once and hands the session to the specs that
 * only need to be signed in - `/auth/login` is rate limited on purpose, and a
 * suite that signs in per case would trip that safeguard.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // The viewer is fully responsive on phones; authoring is desktop-first.
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      dependencies: ['setup'],
    },
  ],
});
