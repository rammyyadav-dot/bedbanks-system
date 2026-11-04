import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { liveDepartmentModules } from '@bedbanks/contracts'
import { ORIGINS } from '../support/config'
import { fixtures, signInAdmin } from '../support/helpers'

const live = liveDepartmentModules()
const viewports = [
  { width: 1280, height: 800, name: 'desktop' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 390, height: 844, name: 'phone' },
] as const

async function documentOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe('Admin browser and security acceptance', () => {
  test('every live module renders for an authorized admin', async ({ page }) => {
    test.setTimeout(240_000)
    expect(live.length).toBeGreaterThanOrEqual(37)
    await signInAdmin(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    for (const module of live) {
      await page.goto(`${ORIGINS.admin}${module.href}`)
      await expect(page, module.href).not.toHaveURL(/\/login/)
      await expect(page.locator('#main-content'), module.href).toBeVisible()
      await expect(page.getByText(/Feature unavailable/i), module.href).toHaveCount(0)
      expect(await documentOverflow(page), module.href).toBeLessThanOrEqual(1)
    }
  })

  for (const viewport of viewports) {
    test(`responsive shell at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
      await signInAdmin(page)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      for (const href of ['/dashboard', '/hotels', '/finance/ledger']) {
        await page.goto(`${ORIGINS.admin}${href}`)
        await expect(page.locator('#main-content')).toBeVisible()
        expect(await documentOverflow(page), `${href} at ${viewport.width}px`).toBeLessThanOrEqual(1)
      }
      await page.keyboard.press('Tab')
      await expect(page.locator(':focus')).toHaveText('Skip to main content')
    })
  }

  test('unauthorized modules show no submit control and send no mutation', async ({ page }) => {
    test.setTimeout(240_000)
    const writes: string[] = []
    page.on('request', (request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && request.url().includes('/api/v1/') && !request.url().includes('/auth/')) {
        writes.push(`${request.method()} ${request.url()}`)
      }
    })
    await signInAdmin(page, 'restricted')
    for (const module of live) {
      await page.goto(`${ORIGINS.admin}${module.href}`)
      const main = page.locator('#main-content')
      if (module.requires) await expect(main.getByText('You do not have permission to view this page'), module.href).toBeVisible()
      await expect(main.locator('button[type="submit"]'), module.href).toHaveCount(0)
    }
    expect(writes).toEqual([])
  })

  test('an expired session returns to sign-in, and a forged tenant cookie cannot switch tenants', async ({ page, context }) => {
    await signInAdmin(page)
    await context.clearCookies()
    await page.goto(`${ORIGINS.admin}/rates`)
    await expect(page).toHaveURL(/\/login\?from=/)
    await signInAdmin(page)
    await context.addCookies([{ name: 'fbeds_active_tenant', value: fixtures().tenantB, url: ORIGINS.admin, httpOnly: true, secure: true, sameSite: 'Lax' }])
    await page.goto(`${ORIGINS.admin}/hotels`)
    await expect(page.locator('#main-content').getByText('Preview Creek Dubai').first()).toBeVisible()
    await expect(page.getByText('Preview Other Tenant Dubai')).toHaveCount(0)
  })

  test('a malformed dashboard body and a dropped API call show an outage, not records', async ({ page }) => {
    await signInAdmin(page)
    await page.route('**/api/v1/admin/dashboard**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"saved":true}' }))
    await page.goto(`${ORIGINS.admin}/dashboard`)
    await expect(page.getByRole('heading', { name: 'Admin service unavailable' })).toBeVisible()
    await expect(page.getByText('Preview Creek Dubai')).toHaveCount(0)
    await page.unroute('**/api/v1/admin/dashboard**')
    await page.route('**/api/v1/admin/dashboard**', (route) => route.abort('failed'))
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible()
  })

  for (const path of ['/login', '/dashboard', '/hotels']) {
    test(`axe: ${path} has no serious or critical WCAG 2.1 A/AA violations`, async ({ page }, testInfo) => {
      if (path !== '/login') await signInAdmin(page)
      await page.goto(`${ORIGINS.admin}${path}`, { waitUntil: 'networkidle' })
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      await testInfo.attach('axe-results.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' })
      const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      expect(blocking.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ') ?? ''}`)).toEqual([])
    })
  }
})
