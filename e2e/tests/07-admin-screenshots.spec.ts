import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { signInAdmin } from '../support/helpers'

// Live screenshots of the Admin console against the real API and the seeded preview tenant.
// Opt-in so the release suite stays fast: `pnpm --filter @bedbanks/e2e e2e:screenshots`.
const OUT = join(__dirname, '..', '.artifacts', 'screenshots', 'admin')

const PAGES: ReadonlyArray<readonly [string, string]> = [
  ['dashboard', '/dashboard'],
  ['hotels', '/hotels'],
  ['suppliers', '/suppliers'],
  ['contracts', '/contracts'],
  ['rates', '/rates'],
  ['inventory', '/inventory'],
  ['bookings', '/bookings'],
  ['holds', '/holds'],
  ['finance', '/finance'],
  ['finance-wallets', '/finance/wallets'],
  ['reliability', '/reliability'],
  ['audit', '/audit'],
  ['users', '/users'],
  ['access-roles', '/access/roles'],
  ['settings', '/settings'],
]

test.describe('Admin console: live screenshots', () => {
  test.skip(process.env.E2E_SCREENSHOTS !== '1', 'set E2E_SCREENSHOTS=1 (pnpm e2e:screenshots) to capture')
  test.use({ viewport: { width: 1440, height: 900 } })

  test('capture every primary admin page as a signed-in admin', async ({ page }) => {
    test.setTimeout(PAGES.length * 30_000)
    mkdirSync(OUT, { recursive: true })
    await page.goto(`${ORIGINS.admin}/login`)
    await page.screenshot({ path: join(OUT, 'login.png') })
    await signInAdmin(page)
    for (const [name, path] of PAGES) {
      await test.step(name, async () => {
        const response = await page.goto(`${ORIGINS.admin}${path}`)
        expect(response?.status(), `${path} status`).toBeLessThan(400)
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true })
      })
    }
  })
})
