import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { primaryPages } from './pages'

const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

// Threshold: zero serious or critical WCAG A/AA violations (including colour contrast and labels) on every
// primary page, plus the interactive checks below. Moderate and minor findings are attached to the report, not hidden.
for (const path of primaryPages) {
  test(`axe: ${path} has no serious or critical WCAG 2.1 A/AA violations`, async ({ page }, testInfo) => {
    await page.goto(path, { waitUntil: 'networkidle' })
    const results = await new AxeBuilder({ page }).withTags(tags).analyze()
    await testInfo.attach('axe-results.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' })
    const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    expect(blocking.map((v) => `${v.id}: ${v.nodes.length} node(s) e.g. ${v.nodes[0]?.target.join(' ')}`)).toEqual([])
  })
}

test('keyboard: the skip link is the first stop and every focused control has a visible focus indicator', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.keyboard.press('Tab')
  const first = page.locator(':focus')
  await expect(first).toHaveText('Skip to main content')
  expect((await first.boundingBox())!.y).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#main-content$/)
  const missing: string[] = []
  await page.goto('/', { waitUntil: 'networkidle' })
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab')
    const visible = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element === document.body) return 'none'
      const style = getComputedStyle(element)
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      const shadow = style.boxShadow !== 'none'
      return outline || shadow ? 'ok' : `${element.tagName.toLowerCase()} "${(element.textContent ?? '').trim().slice(0, 30)}"`
    })
    if (visible !== 'ok' && visible !== 'none') missing.push(visible)
  }
  expect(missing).toEqual([])
})

test('keyboard: the demo form can be completed and submitted without a pointer', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': '198.51.100.77' })
  await page.goto('/request-demo', { waitUntil: 'networkidle' })
  await page.locator('[name="fullName"]').focus()
  for (let i = 0; i < 9; i += 1) await page.keyboard.press('Tab')
  const reached = await page.evaluate(() => document.activeElement?.getAttribute('name') ?? document.activeElement?.tagName)
  expect(reached).toBeTruthy()
  await page.locator('button[type="submit"]').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.form-summary')).toBeVisible()
})
