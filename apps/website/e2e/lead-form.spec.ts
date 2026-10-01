import { expect, test, type Page } from '@playwright/test'

let client = 0
test.beforeEach(async ({ page }) => { client += 1; await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${client}` }) }) // distinct client per test

async function fill(page: Page, overrides: Record<string, string> = {}) {
  const values: Record<string, string> = { fullName: 'Asha Patel', businessEmail: 'asha@example.com', company: 'Example Travel', market: 'United Kingdom', message: 'We need to review a distribution model for several markets.', ...overrides }
  for (const [name, value] of Object.entries(values)) await page.locator(`[name="${name}"]`).fill(value)
  await page.locator('select[name="businessType"]').selectOption({ index: 1 })
  await page.locator('select[name="monthlyVolume"]').selectOption({ index: 1 })
  await page.locator('select[name="interestArea"]').selectOption({ index: 1 })
  await page.locator('[name="consent"]').check()
}

test('labels exist for every field and empty submit shows linked, announced validation errors', async ({ page }) => {
  await page.goto('/request-demo', { waitUntil: 'networkidle' })
  for (const name of ['fullName', 'businessEmail', 'company', 'market', 'businessType', 'monthlyVolume', 'interestArea', 'message', 'consent']) {
    await expect(page.locator(`[name="${name}"]`), name).toHaveAccessibleName(/.+/)
  }
  await page.getByRole('button', { name: /submit|request|send/i }).click()
  const summary = page.locator('.form-summary')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('Check the highlighted fields')
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('form-summary'))).toBe(true)
  for (const name of ['fullName', 'businessEmail', 'company', 'market', 'message']) {
    const input = page.locator(`[name="${name}"]`)
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    const describedBy = await input.getAttribute('aria-describedby')
    expect(describedBy, name).toBeTruthy()
    for (const id of describedBy!.split(/\s+/)) await expect(page.locator(`#${id}`), `${name} -> ${id}`).not.toBeEmpty()
    expect(describedBy!.split(/\s+/).some((id) => id.endsWith('-error')), name).toBe(true)
  }
})

test('a valid enquiry with no lead service configured is reported honestly, never as success', async ({ page }) => {
  await page.goto('/request-demo', { waitUntil: 'networkidle' })
  await fill(page)
  await page.getByRole('button', { name: /submit|request|send/i }).click()
  await expect(page.locator('.form-summary')).toContainText('Online submission was not completed')
  await expect(page.getByText('Thank you. Your enquiry was accepted.')).toHaveCount(0)
})

test('a honeypot hit shows the generic success and sends nothing downstream', async ({ page }) => {
  const downstream: string[] = []
  page.on('request', (request) => { const host = new URL(request.url()).host; if (host !== 'localhost:4710') downstream.push(request.url()) })
  await page.goto('/request-demo', { waitUntil: 'networkidle' })
  await fill(page)
  await page.evaluate(() => { const trap = document.querySelector<HTMLInputElement>('[name="website"]')!; trap.value = 'https://spam.example' })
  await page.getByRole('button', { name: /submit|request|send/i }).click()
  await expect(page.getByText('Thank you. Your enquiry was accepted.')).toBeVisible()
  expect(downstream).toEqual([])
})

test('the sixth submission from one client is rate limited in a real browser', async ({ page }) => {
  await page.goto('/request-demo', { waitUntil: 'networkidle' })
  for (let i = 0; i < 5; i += 1) {
    await page.getByRole('button', { name: /submit|request|send/i }).click()
    await expect(page.locator('.form-summary')).toContainText('Check the highlighted fields')
  }
  await page.getByRole('button', { name: /submit|request|send/i }).click()
  await expect(page.locator('.form-summary')).toContainText('Too many requests')
})
