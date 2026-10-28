import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { isoDay, signInAgent } from '../support/helpers'
import { STATE_DIR } from '../support/stack'

// Live screenshots of the Agent portal against the real API and the seeded preview tenant.
// Opt-in so the release suite stays fast: `pnpm --filter @bedbanks/e2e e2e:screenshots`.
const OUT = join(STATE_DIR, 'screenshots/agent')
const PUBLIC_PAGES: ReadonlyArray<readonly [string, string]> = [['login', '/login'], ['access-request', '/access']]
const PAGES: ReadonlyArray<readonly [string, string]> = [['home', '/'], ['quotations', '/quotations'], ['quotation-new', '/quotations/new'], ['support', '/support'], ['about', '/about'], ['contact', '/contact'], ['news', '/news']]

test.describe('Agent portal: live screenshots', () => {
  test.skip(process.env.E2E_SCREENSHOTS !== '1', 'set E2E_SCREENSHOTS=1 (pnpm e2e:screenshots) to capture')
  test.use({ viewport: { width: 1440, height: 900 } })

  test('capture the Agent portal as a signed-in agent, including a Dubai search result', async ({ page }) => {
    test.setTimeout(120_000)
    mkdirSync(OUT, { recursive: true })
    for (const [name, path] of PUBLIC_PAGES) {
      await page.goto(`${ORIGINS.agent}${path}`)
      await page.waitForLoadState('networkidle')
      await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true })
    }
    await signInAgent(page)
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: join(OUT, 'home.png'), fullPage: true })

    const destination = page.getByPlaceholder('Search destinations & hotels…')
    await destination.click()
    await destination.fill('Dubai')
    await page.getByRole('option', { name: /^Dubai City/ }).click()
    await page.getByRole('button', { name: /nights/ }).first().click()
    await page.getByRole('button', { name: isoDay(14), exact: true }).and(page.locator(':enabled')).first().click()
    await page.getByRole('button', { name: isoDay(16), exact: true }).and(page.locator(':enabled')).first().click()
    await page.getByRole('button', { name: 'Apply dates' }).click()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByText('Preview Creek Dubai').first()).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(OUT, 'search-results.png'), fullPage: true })
    await page.getByRole('button', { name: 'View rooms' }).first().click()
    await page.getByRole('button', { name: 'Select Offer' }).first().click()
    await expect(page.getByText('Offer rechecked')).toBeVisible({ timeout: 20_000 })
    await page.screenshot({ path: join(OUT, 'offer-recheck.png'), fullPage: true })

    for (const [name, path] of PAGES.filter(([n]) => n !== 'home')) {
      await test.step(name, async () => {
        const response = await page.goto(`${ORIGINS.agent}${path}`)
        expect(response?.status(), `${path} status`).toBeLessThan(500)
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true })
      })
    }
  })
})
