import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DATABASE, ORIGINS, PORTS, RUNTIME_LOGIN, pgAdminUrl, urlFor } from './config'

export const REPO = resolve(__dirname, '../..')
export const STATE_DIR = join(REPO, 'e2e/.artifacts')
export const STATE_FILE = join(STATE_DIR, 'stack.json')

export interface StackState {
  fixtures: Record<string, string | string[]>
  /** email -> password. Read from a 0600 file outside the repository; never printed. */
  passwords: Record<string, string>
  pids: number[]
  secretDir: string
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string): string {
  const r = spawnSync(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8' })
  if (r.status !== 0) {
    // stderr can contain a connection string in some tools; print only the tail and the label.
    throw new Error(`${label} failed (exit ${r.status})\n${(r.stderr || r.stdout || '').split('\n').slice(-15).join('\n').replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgresql://<redacted>')}`)
  }
  return r.stdout
}

function sql(adminUrl: string, statement: string): void {
  run('psql', [adminUrl.replace(/\?.*$/, ''), '-v', 'ON_ERROR_STOP=1', '-q', '-c', statement], {}, 'psql')
}

async function waitFor(url: string, ok: (status: number) => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  let last = 'no response'
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (ok(res.status)) return
      last = `HTTP ${res.status}`
    } catch (e) {
      last = (e as Error).message
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  throw new Error(`${label} did not become ready at ${url} within ${ms / 1000}s (${last})`)
}

function launch(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  mkdirSync(STATE_DIR, { recursive: true })
  const log = createWriteStream(join(STATE_DIR, `${name}.log`))
  const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  return child
}

export async function startStack(): Promise<StackState> {
  // Production-mode portals serve whatever was last built. A missing build is an error; a stale one is the caller's to rebuild (CI always builds first).
  for (const app of ['agent', 'admin', 'supplier']) {
    if (!existsSync(join(REPO, 'apps', app, '.next', 'BUILD_ID'))) throw new Error(`apps/${app} is not built. Run: pnpm --filter ./apps/${app} build`)
  }
  const admin = pgAdminUrl()
  const adminDb = urlFor(admin, 'postgres', admin.username, decodeURIComponent(admin.password))
  const ownerUrl = urlFor(admin, DATABASE, admin.username, decodeURIComponent(admin.password))
  const runtimePassword = randomBytes(24).toString('base64url')
  const secretDir = mkdtempSync(join(tmpdir(), 'fbeds-e2e-'))
  const secretFile = join(secretDir, 'fixtures.json')

  // 1. Fresh disposable database. The name is fixed; nothing else is ever dropped.
  sql(adminDb, `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
  sql(adminDb, `CREATE DATABASE ${DATABASE}`)

  // 2. Real, forward-only migrations as owner (never `migrate dev`).
  run('pnpm', ['--filter', '@bedbanks/api', 'prisma:migrate:deploy'], { DATABASE_URL: ownerUrl }, 'migrate deploy')

  // 3. The strict runtime role, exactly as production provisions it.
  run('pnpm', ['--filter', '@bedbanks/api', 'ops:provision-api-runtime-role'], { PROVISION_DATABASE_URL: ownerUrl, API_RUNTIME_LOGIN_PASSWORD: runtimePassword }, 'provision runtime role')

  // 4. Explicit, disposable fixtures (two tenants, admin/agent/supplier accounts).
  const out = run('pnpm', ['--filter', '@bedbanks/api', 'ops:provision-preview-fixtures'], { PROVISION_DATABASE_URL: ownerUrl, PREVIEW_FIXTURE_SECRET_FILE: secretFile }, 'provision fixtures')
  const fixtures = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()!)
  const passwords = (JSON.parse(readFileSync(secretFile, 'utf8')) as { accounts: Record<string, string> }).accounts

  // 5. API under the strict runtime role, secure cookies, booking disabled.
  const runtimeUrl = urlFor(admin, DATABASE, RUNTIME_LOGIN, runtimePassword)
  const portalOrigins = [ORIGINS.agent, ORIGINS.admin, ORIGINS.supplier]
  const api = launch('api', 'pnpm', ['--filter', '@bedbanks/api', 'start'], {
    NODE_ENV: 'development',
    API_PORT: String(PORTS.api),
    API_HOST: '127.0.0.1',
    DATABASE_URL: runtimeUrl,
    AUTH_COOKIE_SECURE: 'true',
    ADMIN_ORIGIN: ORIGINS.admin,
    TRUSTED_ORIGINS: [ORIGINS.agent, ORIGINS.supplier].join(','),
    BOOKING_ENABLED: process.env.E2E_BOOKING_ENABLED ?? 'false', // only the mutation check overrides this
  })
  const pids = [api.pid!]
  await waitFor(`${ORIGINS.api}/api/v1/health`, (s) => s === 200, 120_000, 'API').catch(async (e) => {
    throw new Error(`${e.message}\nSee e2e/.artifacts/api.log`)
  })

  // 6. The three portals, production-mode builds, talking to the API through their runtime origin.
  const apiInternal = `${ORIGINS.api}/api/v1`
  const portals: Array<[string, string, number]> = [['agent', 'agent', PORTS.agent], ['admin', 'admin', PORTS.admin], ['supplier', 'supplier', PORTS.supplier]]
  for (const [name, dir, port] of portals) {
    const child = launch(name, 'pnpm', ['--filter', `./apps/${dir}`, 'exec', 'next', 'start', '--port', String(port)], {
      NODE_ENV: 'production',
      API_INTERNAL_URL: apiInternal,
      // Must equal the origin the API trusts for this portal (CORS + CSRF-style origin check).
      AUTH_API_ORIGIN: `http://localhost:${port}`,
      SUPPLIER_ORIGIN: `http://localhost:${port}`,
      PORT: String(port),
    })
    pids.push(child.pid!)
  }
  await Promise.all(portals.map(([name, , port]) => waitFor(`http://localhost:${port}/`, (s) => s > 0 && s < 500, 90_000, `${name} portal`)))

  void portalOrigins
  const state: StackState = { fixtures, passwords, pids, secretDir }
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ pids, secretDir }), { mode: 0o600 })
  writeFileSync(join(secretDir, 'state.json'), JSON.stringify(state), { mode: 0o600 })
  return state
}

export function stopStack(state?: { pids: number[]; secretDir: string }): void {
  const s = state ?? (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined)
  if (!s) return
  for (const pid of s.pids) {
    try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
  }
  try { rmSync(s.secretDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { rmSync(STATE_FILE, { force: true }) } catch { /* best effort */ }
}

/** Loads the state of a running stack (started by global setup or `pnpm e2e:up`). Credentials stay in the OS temp dir. */
export function loadState(): StackState {
  if (!existsSync(STATE_FILE)) throw new Error('No running E2E stack. Run `pnpm --filter @bedbanks/e2e e2e` (starts one) or `pnpm --filter @bedbanks/e2e e2e:up`.')
  const { secretDir } = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  return JSON.parse(readFileSync(join(secretDir, 'state.json'), 'utf8')) as StackState
}

/** Row counts, read as the database owner, for the tables that must not change while booking is closed. */
export function moneyAndBookingCounts(): Record<string, number> {
  const admin = pgAdminUrl()
  const url = urlFor(admin, DATABASE, admin.username, decodeURIComponent(admin.password)).replace(/\?.*$/, '')
  const tables = ['Booking', 'BookingGuest', 'BookingSupplierCall', 'InventoryHold', 'InventoryHoldNight', 'LedgerEntry', 'BookingFinanceEvent']
  const sqlText = tables.map((t) => `select '${t}', count(*) from "${t}"`).join(' union all ')
  const out = run('psql', [url, '-At', '-F', '|', '-c', sqlText], {}, 'count rows')
  return Object.fromEntries(out.trim().split('\n').map((l) => { const [t, n] = l.split('|'); return [t, Number(n)] }))
}
