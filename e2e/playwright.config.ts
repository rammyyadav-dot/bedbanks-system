import { defineConfig } from '@playwright/test'
import path from 'node:path'

/**
 * Browser journeys against the REAL stack: the Nest API, the Next Admin console, PostgreSQL (forced row-level security) and Redis. Nothing is mocked.
 * The API runs as NODE_ENV=test with the runtime-role guard off (the only combination the API allows that), because the journeys author rates as an operator would;
 * the locked-down role is certified separately by the strict-role boot smoke. The database must be a disposable local one (the setup refuses anything else). Start it first, e.g. the CI cluster on port 5433, and Redis on 6390:
 *
 *   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/fbeds_ci pnpm --dir e2e test
 */
const databaseUrl = process.env.E2E_DATABASE_URL ?? ''
let host = ''; let name = ''
try { const url = new URL(databaseUrl); host = url.hostname; name = url.pathname.slice(1) } catch { /* reported below */ }
if (!['localhost', '127.0.0.1'].includes(host) || !/^(fbeds_ci|p0\d_[a-z0-9_]+)$/.test(name)) {
  throw new Error('E2E_DATABASE_URL must point at a local disposable database (fbeds_ci or p0N_*). Refusing to run.')
}
process.env.DATABASE_URL = databaseUrl

const API_PORT = Number(process.env.E2E_API_PORT ?? 3902)
const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 3901)
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 3900)
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6390'
const adminOrigin = `http://localhost:${ADMIN_PORT}`
const root = path.join(__dirname, '..')

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  use: { baseURL: adminOrigin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'node --no-experimental-strip-types -r @swc-node/register src/main.ts',
      cwd: path.join(root, 'apps', 'api'),
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test', DB_RUNTIME_ROLE_GUARD: 'off', API_HOST: '127.0.0.1', API_PORT: String(API_PORT), ADMIN_ORIGIN: adminOrigin, TRUSTED_ORIGINS: `http://localhost:${AGENT_PORT}`,
        DATABASE_URL: databaseUrl, MAPPING_DATABASE_URL: databaseUrl, REDIS_URL, AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAME_SITE: 'lax',
        // The default: activation needs a second person. The journeys prove that flow, so it is not switched off.
        RATE_PLAN_ACTIVATION_APPROVAL: 'required',
      },
    },
    {
      command: `pnpm exec next dev --port ${ADMIN_PORT}`,
      cwd: path.join(root, 'apps', 'admin'),
      url: `${adminOrigin}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}/api/v1`, AUTH_API_ORIGIN: adminOrigin, AUTH_COOKIE_NAME: 'fbeds_session', NEXT_TELEMETRY_DISABLED: '1' },
    },
    {
      command: `pnpm exec next dev --port ${AGENT_PORT}`,
      cwd: path.join(root, 'apps', 'agent'),
      url: `http://localhost:${AGENT_PORT}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}/api/v1`, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
})
