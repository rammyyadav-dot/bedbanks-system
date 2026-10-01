import { defineConfig } from '@playwright/test'

const port = Number(process.env.WEBSITE_E2E_PORT ?? 4710)
export const baseURL = `http://localhost:${port}`
export const expectedSiteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.fbeds.com'

// Runs against a started PRODUCTION build (`pnpm build` first), never the dev server.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `pnpm exec next start -p ${port}`,
    url: baseURL,
    reuseExistingServer: true, // CI starts the production server itself so check:site and the browser tests share it
    timeout: 60_000,
    env: { NEXT_PUBLIC_SITE_URL: expectedSiteUrl },
  },
})
