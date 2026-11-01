import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { fixtures, signInSupplier } from '../support/helpers'
import { STATE_DIR } from '../support/stack'

// Live screenshots of the Supplier extranet, taken against the real API and the disposable database.
// Output: e2e/.artifacts/screenshots/supplier/*.png (git-ignored). This records what a supplier actually
// sees today, including the honest "unavailable" states; it does not assert that unavailable modules work.
const OUT = join(STATE_DIR, 'screenshots/supplier')

const ROUTES = [
  '/dashboard', '/hotels', '/hotels/new', '/contracts', '/contracts/new', '/supplier-profile', '/rooms', '/rates', '/rates/calendar',
  '/inventory', '/availability', '/availability/allocations', '/availability/stop-sales', '/allotments', '/promotions', '/restrictions',
  '/bookings', '/vouchers', '/finance', '/invoices', '/reports', '/connectivity', '/integrations', '/team', '/settings', '/support', '/help',
]

test.describe('Supplier extranet: live screenshots', () => {
  test.beforeAll(() => mkdirSync(OUT, { recursive: true }))
  test.use({ viewport: { width: 1440, height: 900 } })

  test('login page', async ({ page }) => {
    await page.goto(`${ORIGINS.supplier}/login`)
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await page.screenshot({ path: join(OUT, '00-login.png'), fullPage: true })
  })

  test('every portal route renders for the Alpha editor', async ({ page }) => {
    await signInSupplier(page, 'supplierEditor')
    const fx = fixtures()
    const routes = [...ROUTES, `/hotels/${fx.hotelAlpha}`, `/hotels/${fx.hotelAlpha}/rooms`]
    for (const [i, route] of routes.entries()) {
      const res = await page.goto(`${ORIGINS.supplier}${route}`, { waitUntil: 'networkidle' })
      expect(res?.status(), route).toBeLessThan(500)
      await expect(page.locator('main').first()).toBeVisible()
      const name = route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/cm[a-z0-9]{20,}/g, 'id')
      await page.screenshot({ path: join(OUT, `${String(i + 1).padStart(2, '0')}-${name}.png`), fullPage: true })
    }
  })

  test('mobile layout', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signInSupplier(page, 'supplierEditor')
    await page.screenshot({ path: join(OUT, 'mobile-dashboard.png'), fullPage: true })
    await page.goto(`${ORIGINS.supplier}/hotels`, { waitUntil: 'networkidle' })
    await page.screenshot({ path: join(OUT, 'mobile-hotels.png'), fullPage: true })
  })
})
