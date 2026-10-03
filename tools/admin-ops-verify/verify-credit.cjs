// Real-stack browser verification of the agency credit limit panel (ADR 0024). See README.md. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-credit.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
async function openCredit(page) {
  await page.goto(`${BASE}/clients/agencies`); await page.waitForSelector('[data-testid=agencies-table]', { timeout: 20000 })
  await page.locator('tr', { hasText: seed.agencyName }).getByRole('button', { name: 'Credit' }).click()
  await page.waitForSelector('[data-testid=agency-credit] [data-testid=credit-none], [data-testid=agency-credit] [data-testid=credit-position]', { timeout: 15000 })
}
const panel = (page) => page.getByTestId('agency-credit')

;(async () => {
  const browser = await chromium.launch()
  const maker = await login(browser, seed.makerEmail)
  await openCredit(maker.page)
  check('with no limit the panel says nothing is enforced', /No limit configured/.test(await panel(maker.page).innerText()))
  await panel(maker.page).getByLabel('Limit').fill('1000.555')
  check('an amount with too many decimals is not accepted (no request can be sent)', await maker.page.getByTestId('credit-request-set').isDisabled())
  await panel(maker.page).getByLabel('Limit').fill('1000.50'); await panel(maker.page).getByLabel('Reason (required)').fill('Agreed with finance')
  await maker.page.getByTestId('credit-request-set').click()
  await maker.page.waitForSelector('[data-testid=credit-request]', { timeout: 15000 })
  const pending = await panel(maker.page).innerText()
  check('the request shows the exact amount in the currency format and its status', /pending/i.test(pending) && /AED\s?1,?000\.50/.test(pending), pending.slice(0, 200))
  check('the requester can withdraw but not approve', (await maker.page.getByTestId('credit-cancel').count()) === 1 && (await maker.page.getByTestId('credit-approve').count()) === 0)

  const checker = await login(browser, seed.checkerEmail)
  await openCredit(checker.page)
  await checker.page.getByTestId('credit-request').waitFor()
  check('a different manager can approve or reject, and cannot apply yet', (await checker.page.getByTestId('credit-approve').count()) === 1 && (await checker.page.getByTestId('credit-execute').count()) === 0)
  await panel(checker.page).getByLabel('Decision reason (required)').fill('Checked against the contract')
  await checker.page.getByTestId('credit-approve').click()
  await checker.page.waitForSelector('[data-testid=credit-execute]', { timeout: 15000 })
  await checker.page.getByTestId('credit-execute').click()
  await checker.page.waitForSelector('[data-testid=credit-position]', { timeout: 15000 })
  const applied = await panel(checker.page).innerText()
  check('after apply the limit, committed and available are shown', /AED\s?1,?000\.50/.test(await checker.page.getByTestId('credit-limit').innerText()) && /0\.00/.test(await checker.page.getByTestId('credit-committed').innerText()) && /1,?000\.50/.test(await checker.page.getByTestId('credit-available').innerText()), applied.slice(0, 200))
  await checker.page.reload(); await openCredit(checker.page)
  check('the limit persists after a reload', /1,?000\.50/.test(await checker.page.getByTestId('credit-limit').innerText()))
  check('the panel states there is no override and no wallet or payment', /no override/i.test(await panel(checker.page).innerText()) && /not a wallet or a payment/i.test(await panel(checker.page).innerText()))

  await checker.page.getByLabel('Reason (required)').fill('No longer needed'); await checker.page.getByTestId('credit-request-remove').click()
  await checker.page.waitForSelector('[data-testid=credit-request]', { timeout: 15000 })
  check('removing a limit is also a request needing another person', /remove the limit/i.test(await checker.page.getByTestId('credit-request').innerText()) && (await checker.page.getByTestId('credit-approve').count()) === 0)
  await maker.ctx.close(); await checker.ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
