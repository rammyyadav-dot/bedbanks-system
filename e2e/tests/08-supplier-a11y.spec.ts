import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { fixtures, signInSupplier } from '../support/helpers'

const ROUTES = ['/dashboard', '/hotels', '/contracts', '/bookings', '/rooms', '/rates', '/inventory', '/availability', '/allotments', '/promotions', '/restrictions', '/vouchers', '/invoices', '/supplier-profile']

test('supplier extranet: automated accessibility scan (WCAG 2.1 A/AA)', async ({ page }) => {
  await signInSupplier(page, 'supplierEditor')
  const fx = fixtures()
  const found: string[] = []
  for (const route of [...ROUTES, `/hotels/${fx.hotelAlpha}`]) {
    await page.goto(`${ORIGINS.supplier}${route}`, { waitUntil: 'networkidle' })
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    for (const v of violations) for (const n of v.nodes) found.push(`${route.replace(fx.hotelAlpha, ":id")} ${v.id} (${v.impact}): ${n.target.join(" ")} ${n.any[0]?.message ?? ""}`)
  }
  console.log(found.join('\n') || 'no violations')
  expect(found).toEqual([])
})
