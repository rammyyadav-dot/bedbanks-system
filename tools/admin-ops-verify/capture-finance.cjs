// Real-stack capture of the Admin Finance module: full-page screenshots, a video of the whole walk-through and a Playwright trace.
// Run after seed-finance.ts against a disposable local database, the API and the production Admin build (see README.md). Not run in CI.
//   SEED_JSON=<seed-finance.json> OUT_DIR=<folder> node tools/admin-ops-verify/capture-finance.cjs
const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-finance.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const OUT = process.env.OUT_DIR ?? path.join(__dirname, 'finance-capture')
fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true })
const log = []
let n = 0
const shot = async (page, name, note) => {
  const file = `${String(++n).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: path.join(OUT, 'screenshots', file), fullPage: true })
  log.push({ file, note }); console.log('shot', file)
}
const settle = async (page, ms = 900) => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms) }
async function go(page, url, ready) {
  await page.goto(`${BASE}${url}`)
  if (ready) await page.waitForSelector(ready, { timeout: 25000 })
  await settle(page)
}
async function login(page, email) {
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25000 }), page.click('button[type=submit]')])
  await settle(page)
}

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: path.join(OUT, 'video'), size: { width: 1440, height: 900 } }, colorScheme: 'light' })
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false })
  const page = await ctx.newPage()
  const failures = []
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) failures.push(`${r.status()} ${new URL(r.url()).pathname}`) })
  page.on('pageerror', (e) => failures.push(`pageerror ${e.message.slice(0, 120)}`))

  await login(page, seed.adminEmail)
  await go(page, '/finance'); await shot(page, 'finance-home', 'Finance home')
  await go(page, '/finance/wallets'); await shot(page, 'wallets', 'Agency accounts: balance, credit line and available credit per account and currency')
  await go(page, '/finance/ledger'); await shot(page, 'ledger', 'Immutable ledger entries, newest first')
  await go(page, '/finance/funding'); await shot(page, 'funding-receipts', 'Funding receipts in every state: declared, verified, posted, rejected; cash and third-party flagged for compliance')
  await go(page, '/finance/receivables'); await shot(page, 'receivables', 'Receivables: agencies with unpaid charges, notice at 7 days, new bookings refused at 30')
  await go(page, '/finance/payables'); await shot(page, 'supplier-payables', 'Supplier payables accrual per supplier and currency')
  await go(page, '/finance/refunds'); await shot(page, 'refund-register', 'Refund register')
  await go(page, '/finance/credit-notes'); await shot(page, 'credit-notes', 'Credit note register')

  // Ledger integrity: the new control, nightly record and live check.
  await go(page, '/finance/integrity', '[data-testid=nightly-banner]')
  await page.waitForSelector('[data-testid=integrity-verdict]', { timeout: 25000 }); await settle(page)
  await shot(page, 'ledger-integrity-overview', 'Ledger integrity: nightly record with history, and the live check')
  const tonight = page.locator('[data-testid^=nightly-run-]').first()
  await tonight.getByRole('button', { name: 'View' }).click()
  await page.waitForSelector('[data-testid=stored-run]', { timeout: 20000 }); await settle(page)
  await page.locator('[data-testid=stored-run]').scrollIntoViewIfNeeded()
  await shot(page, 'ledger-integrity-stored-night', 'Tonight\'s recorded night opened exactly as stored, with its findings')
  await page.locator('[data-testid=stored-run]').screenshot({ path: path.join(OUT, 'screenshots', `${String(++n).padStart(2, '0')}-ledger-integrity-findings-closeup.png`) })
  log.push({ file: `${String(n).padStart(2, '0')}-ledger-integrity-findings-closeup.png`, note: 'Close-up of the recorded findings' })

  // Agency account position from the Clients module.
  await go(page, '/clients/agencies')
  await shot(page, 'agencies', 'Agencies list (entry point to each agency\'s account and credit)')

  // Phone width of the new page.
  await page.setViewportSize({ width: 390, height: 844 })
  await go(page, '/finance/integrity', '[data-testid=nightly-banner]'); await shot(page, 'ledger-integrity-phone', 'Ledger integrity at phone width')
  await page.setViewportSize({ width: 1440, height: 900 })

  // A user without finance access sees a clear refusal, not an empty page.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p2 = await ctx2.newPage()
  await login(p2, seed.viewerEmail); await go(p2, '/finance/ledger'); await p2.waitForTimeout(1200)
  await shot(p2, 'no-finance-access', 'A user without finance permission is refused clearly'); await ctx2.close()

  await ctx.tracing.stop({ path: path.join(OUT, 'trace.zip') })
  await ctx.close()  // flushes the video
  await browser.close()
  const vids = fs.readdirSync(path.join(OUT, 'video')).filter((f) => f.endsWith('.webm'))
  if (vids[0]) fs.renameSync(path.join(OUT, 'video', vids[0]), path.join(OUT, 'finance-walkthrough.webm'))
  fs.rmSync(path.join(OUT, 'video'), { recursive: true, force: true })
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ screenshots: log, serverErrorsSeen: failures }, null, 2))
  console.log(failures.length ? `SERVER ERRORS: ${failures.join(' | ')}` : 'no server errors during the walk-through')
})().catch((e) => { console.error(e); process.exit(1) })
