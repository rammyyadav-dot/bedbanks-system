import { expect, test, type Page } from '@playwright/test'
import { primaryPages } from './pages'

/** Collects CSP violations, console errors and request origins for a page load. */
async function observe(page: Page) {
  const violations: string[] = []; const errors: string[] = []; const hosts = new Set<string>(); const badResponses: string[] = []
  await page.addInitScript(() => { (window as unknown as { __csp: string[] }).__csp = []; document.addEventListener('securitypolicyviolation', (event) => (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`)) })
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => hosts.add(new URL(request.url()).host))
  // /_vercel/insights/* only exists on Vercel, so a local production run legitimately 404s there; nothing else may fail.
  page.on('response', (response) => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/_vercel/insights/')) badResponses.push(`${response.status()} ${response.url()}`) })
  return { violations, errors, hosts, badResponses, collect: async () => (await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).concat(violations) }
}

for (const path of primaryPages) {
  test(`production page ${path} hydrates with no CSP violations, errors or third-party requests`, async ({ page, baseURL }) => {
    const seen = await observe(page)
    const response = await page.goto(path, { waitUntil: 'networkidle' })
    expect(response?.status()).toBeLessThan(400)
    const policy = response!.headers()['content-security-policy']
    expect(policy).toContain("script-src 'self' 'nonce-")
    expect(policy).not.toMatch(/unsafe-(inline|eval)/)
    expect(response!.headers()['cache-control']).toMatch(/no-store/)
    expect(await seen.collect()).toEqual([])
    expect(seen.badResponses).toEqual([])
    // Outside Vercel the first-party analytics script 404s (MIME error, not a CSP block); any other console error fails.
    expect(seen.errors.filter((text) => !text.startsWith('Failed to load resource') && !text.includes('/_vercel/insights/script.js'))).toEqual([])
    expect([...seen.hosts]).toEqual([new URL(baseURL!).host])
  })
}

test('each document request gets a different nonce and every script tag carries it', async ({ request }) => {
  const nonces = new Set<string>()
  for (let i = 0; i < 3; i += 1) {
    const response = await request.get('/about')
    const nonce = /'nonce-([^']+)'/.exec(response.headers()['content-security-policy'])![1]
    nonces.add(nonce)
    const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? []
    for (const tag of scripts.filter((tag) => !/application\/ld\+json/.test(tag))) expect(tag).toContain(`nonce="${nonce}"`)
  }
  expect(nonces.size).toBe(3)
})

test('client-side navigation works under the CSP (no full reload)', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.evaluate(() => { (window as unknown as { __marker: string }).__marker = 'kept' })
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Platform' }).click()
  await expect(page).toHaveURL(/\/platform$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('kept')
})

test('the mobile menu opens and closes (client JavaScript runs)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/', { waitUntil: 'networkidle' })
  const trigger = page.getByRole('button', { name: 'Open navigation' })
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'Close navigation' }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('the site renders with a system font stack and requests no remote fonts', async ({ page }) => {
  const fontRequests: string[] = []
  page.on('request', (request) => { if (request.resourceType() === 'font' || /fonts\.(googleapis|gstatic)\.com/.test(request.url())) fontRequests.push(request.url()) })
  await page.goto('/', { waitUntil: 'networkidle' })
  expect(fontRequests).toEqual([])
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
  expect(family).toMatch(/system-ui|Segoe UI|Roboto|Arial/)
})

test('images and icons load under img-src', async ({ page, request }) => {
  const failed: string[] = []
  page.on('requestfailed', (req) => { if (!req.url().includes('_rsc=') && req.failure()?.errorText !== 'net::ERR_ABORTED') failed.push(req.url()) })
  await page.goto('/', { waitUntil: 'networkidle' })
  expect(failed).toEqual([])
  for (const url of ['/icon', '/apple-icon', '/opengraph-image', '/manifest.webmanifest']) expect((await request.get(url)).ok(), url).toBe(true)
})

test('capability copy distinguishes coming soon from available (no unsupported live claims)', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'networkidle' })
  await expect(page.getByText('Booking is in development.')).toBeVisible()
  await expect(page.getByText('Coming soon: manage supply, content and distribution relationships.')).toBeVisible()
  await expect(page.getByRole('note').first()).toContainText('not generally available yet')
  await page.goto('/connectivity', { waitUntil: 'networkidle' })
  await expect(page.getByText('API and XML adapters (coming soon)')).toBeVisible()
  for (const path of ['/', '/platform', '/inventory', '/connectivity', '/login']) {
    await page.goto(path, { waitUntil: 'networkidle' })
    const text = (await page.locator('main').innerText()).toLowerCase()
    for (const claim of ['book instantly', 'real-time inventory', 'live inventory', 'instant confirmation', 'now live', 'sign in to book']) expect(text, `${path}: ${claim}`).not.toContain(claim)
  }
})
