// Real-stack browser verification of the hotel Images tab (ADR 0027). Uses the hotels seed (seed-hotels.ts). See README.md. Not run in CI.
const path = require('path')
const zlib = require('zlib')
const fs = require('fs')
const os = require('os')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotels.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }

/** A real, decodable solid-colour PNG (so the browser can actually render it). */
function makePng(w, h, rgb) {
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotel-images-'))
  const red = path.join(dir, 'red.png'); const blue = path.join(dir, 'blue.png'); const small = path.join(dir, 'small.png'); const text = path.join(dir, 'notes.txt')
  fs.writeFileSync(red, makePng(800, 600, [200, 30, 30])); fs.writeFileSync(blue, makePng(1000, 700, [30, 30, 200])); fs.writeFileSync(small, makePng(400, 300, [0, 120, 0])); fs.writeFileSync(text, 'not an image')
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  await page.goto(`${BASE}/hotels/${seed.hotels.alpha}?tab=images`); await page.waitForSelector('[data-testid=hotel-images] [data-testid=images-empty], [data-testid=image-grid]', { timeout: 20000 })
  const first = await page.getByTestId('hotel-images').innerText()
  check('the tab no longer says images are unavailable and states the real limits', !/not available yet/i.test(first) && /5 MB/.test(first) && /30 images/.test(first))
  check('with none uploaded it says so, and shows nothing invented', (await page.getByTestId('images-empty').count()) === 1 && (await page.locator('img').count()) === 0 || (await page.getByTestId('image-card').count()) === 0)

  check('upload is disabled until a file and alt text are given', await page.getByTestId('image-upload-submit').isDisabled())
  await page.getByTestId('image-file').setInputFiles(text)
  check('a non-image file is refused in the browser before any request', /JPEG, PNG or WebP/.test(await page.getByTestId('image-upload').innerText()))
  await page.getByTestId('image-file').setInputFiles(small); await page.getByLabel('Alt text (required)').fill('Too small')
  await page.getByTestId('image-upload-submit').click()
  await page.waitForSelector('[data-testid=image-notice][role=alert]', { timeout: 15000 })
  check('an image under the minimum size is refused by the server with its reason', /pixels/.test(await page.getByTestId('image-notice').innerText()))

  await page.getByTestId('image-file').setInputFiles(red); await page.getByLabel('Alt text (required)').fill('Red lobby')
  await page.getByTestId('image-upload-submit').click()
  await page.waitForSelector('[data-testid=image-card]', { timeout: 15000 })
  check('the first upload appears, marked primary, and the picture really renders', (await page.getByTestId('image-card').count()) === 1 && (await page.locator('[data-testid=image-card]').first().getAttribute('data-primary')) === 'true')
  check('the browser decoded the image bytes served by the API', await page.locator('[data-testid=image-card] img').first().evaluate((el) => el.complete && el.naturalWidth === 800 && el.naturalHeight === 600))
  await page.getByTestId('image-file').setInputFiles(blue); await page.getByLabel('Alt text (required)').fill('Blue pool')
  await page.getByTestId('image-upload-submit').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=image-card]').length === 2, null, { timeout: 15000 })
  await page.getByTestId('image-file').setInputFiles(blue); await page.getByLabel('Alt text (required)').fill('Blue pool again')
  await page.getByTestId('image-upload-submit').click()
  await page.waitForSelector('[data-testid=image-notice][role=alert]', { timeout: 15000 })
  check('the same picture twice is refused as a duplicate', /already on the hotel/.test(await page.getByTestId('image-notice').innerText()))

  const cards = page.getByTestId('image-card')
  await cards.nth(1).getByRole('button', { name: 'Make primary' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=image-card][data-primary=true]').length === 1 && document.querySelectorAll('[data-testid=image-card]')[1]?.getAttribute('data-primary') === 'true', null, { timeout: 15000 })
  check('making another image primary leaves exactly one primary', (await page.locator('[data-testid=image-card][data-primary=true]').count()) === 1)
  await cards.nth(1).getByRole('button', { name: 'Move earlier' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=image-card]')[0]?.getAttribute('data-primary') === 'true', null, { timeout: 15000 })
  check('moving an image earlier changes the order the server returns', (await cards.nth(0).locator('img').getAttribute('alt')) === 'Blue pool')
  await cards.nth(0).getByLabel('Alt text').fill('Blue infinity pool'); await cards.nth(0).getByRole('button', { name: 'Save alt text' }).click()
  await page.waitForSelector('[data-testid=image-notice]:has-text("Alt text saved")', { timeout: 15000 })
  await page.reload(); await page.waitForSelector('[data-testid=image-grid]')
  check('alt text, order and primary persist after a reload', (await page.getByTestId('image-card').nth(0).locator('img').getAttribute('alt')) === 'Blue infinity pool' && (await page.getByTestId('image-card').nth(0).getAttribute('data-primary')) === 'true')
  page.once('dialog', (d) => d.accept())
  await page.getByTestId('image-card').nth(0).getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=image-card]').length === 1, null, { timeout: 15000 })
  check('deleting the primary promotes the remaining image', (await page.getByTestId('image-card').nth(0).getAttribute('data-primary')) === 'true')
  await page.setViewportSize({ width: 390, height: 800 })
  check('no horizontal page overflow on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${BASE}/hotels?search=${encodeURIComponent('Atlantis')}`); await page.waitForSelector(`tr[data-hotel-id="${seed.hotels.alpha}"]`, { timeout: 20000 })
  const alphaRow = page.locator(`tr[data-hotel-id="${seed.hotels.alpha}"]`)
  await alphaRow.locator('[data-testid=hotel-thumb] img').waitFor({ timeout: 15000 })
  check('the directory row shows the hotel\'s real primary image, decoded by the browser', await alphaRow.locator('[data-testid=hotel-thumb] img').evaluate((el) => el.complete && el.naturalWidth >= 800))
  await page.goto(`${BASE}/hotels?search=${encodeURIComponent('Burj')}`); await page.waitForSelector('tr[data-hotel-id]', { timeout: 20000 })
  check('a hotel without images shows its initial and no picture', (await page.locator('tr[data-hotel-id] [data-testid=hotel-initial]').count()) >= 1 && (await page.locator('tr[data-hotel-id] [data-testid=hotel-thumb]').count()) === 0)
  check('no horizontal page overflow with thumbnails', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  const viewer = await login(browser, seed.viewerEmail)
  await viewer.page.goto(`${BASE}/hotels/${seed.hotels.alpha}?tab=images`); await viewer.page.waitForSelector('[data-testid=image-grid]', { timeout: 20000 })
  check('a read-only user sees the images and no upload, edit or delete controls', (await viewer.page.getByTestId('image-upload').count()) === 0 && (await viewer.page.getByRole('button', { name: 'Delete' }).count()) === 0 && /view images but not change/.test(await viewer.page.getByTestId('hotel-images').innerText()))
  const status = await viewer.page.evaluate(async (id) => (await fetch(`/api/v1/admin/hotels/${id}/images?altText=x`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1, 2, 3]) })).status, seed.hotels.alpha)
  check('and the API refuses their upload', status === 403, status)
  await ctx.close(); await viewer.ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
