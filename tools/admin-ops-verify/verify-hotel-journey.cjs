// Real-stack browser verification of the whole hotel setup journey with the API on the STRICT runtime role (ADR 0032). See README.md. Not run in CI.
// create hotel -> Hotel Setup -> room (create, archive, restore) -> amenities -> image -> completeness -> maker-checker publication.
const path = require('path')
const zlib = require('zlib')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotel-journey.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }

/** A real, decodable PNG (solid colour), built without dependencies. */
function png(w, h, [r, g, b]) {
  const crc = (buf) => { const n = Buffer.alloc(4); n.writeUInt32BE(zlib.crc32(buf) >>> 0); return n }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); return Buffer.concat([len, body, crc(body)]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])
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
  const browser = await chromium.launch()
  const { page } = await login(browser, seed.makerEmail)

  // ---- 1. Add hotel hands off into Hotel Setup ----
  await page.goto(`${BASE}/hotels/new`); await page.waitForSelector('form')
  check('Add hotel explains the journey and that publication needs a second person', /second person must approve/.test(await page.getByTestId('new-hotel-steps').innerText()))
  await page.getByLabel(/^name$/i).fill('Journey Palm Hotel'); await page.getByLabel(/^city$/i).fill('Dubai'); await page.getByLabel(/^country code$/i).fill('AE')
  await page.getByRole('button', { name: 'Create hotel' }).click(); await page.waitForURL(/\/hotels\/[^/?]+\?tab=setup/, { timeout: 20000 }); await page.waitForSelector('[data-testid=setup-form]', { timeout: 20000 })
  const hotelId = new URL(page.url()).pathname.split('/').pop()
  check('creating a hotel on the strict role succeeds and opens Hotel Setup', Boolean(hotelId) && /tab=setup/.test(page.url()))

  // ---- 2. Hotel Setup ----
  await page.getByLabel('Latitude').fill('25.1234'); await page.getByLabel('Longitude').fill('55.1234'); await page.getByLabel('Area').fill('Palm Jumeirah')
  await page.getByLabel('Street address').fill('1 Palm Road'); await page.getByLabel('Star category').selectOption('4'); await page.getByLabel('Category verified').check()
  await page.getByLabel('Source of the category').fill('Tourism authority register'); await page.getByLabel('Short description (max 500)').fill('A quiet hotel on the Palm.')
  await page.getByLabel('Check-in time (hotel local)').fill('14:00'); await page.getByLabel('Check-out time (hotel local)').fill('12:00')
  await page.getByLabel('reservations name').fill('Front desk'); await page.getByLabel('reservations email').fill('journey-res@hotel.test')
  await page.getByTestId('setup-save').click(); await page.waitForSelector('[data-testid=setup-notice]:has-text("Saved")', { timeout: 15000 })
  await page.reload(); await page.waitForSelector('[data-testid=setup-form]')
  check('Hotel Setup saves the profile and the hotel row on the strict role, read back after a reload', (await page.getByLabel('Street address').inputValue()) === '1 Palm Road' && (await page.getByLabel('Area').inputValue()) === 'Palm Jumeirah')

  // ---- 3. Rooms ----
  await page.goto(`${BASE}/hotels/${hotelId}?tab=rooms`); await page.waitForSelector('table[aria-label=Rooms], [data-testid=rooms-empty]', { timeout: 20000 })
  await page.getByRole('button', { name: '+ Add room' }).click(); await page.waitForSelector('[data-testid=room-editor]')
  await page.getByLabel('Room name').fill('Deluxe King'); await page.getByLabel('Room code').fill('DK-1'); await page.getByLabel('Max adults').fill('2'); await page.getByLabel('Max children').fill('1'); await page.getByLabel('Max total occupancy').fill('3')
  await page.getByLabel('King beds').fill('1'); await page.getByLabel('Extra bed').selectOption('SUPPORTED'); await page.getByLabel('Balcony', { exact: true }).check()
  await page.getByTestId('room-save').click(); await page.waitForSelector('[data-testid=rooms-flash]:has-text("Room created")', { timeout: 15000 })
  const roomRow = () => page.locator('table[aria-label=Rooms] tbody tr', { hasText: 'Deluxe King' })
  check('a room with bedding and an amenity is created on the strict role', /1 King/.test(await roomRow().innerText()) && /Balcony/.test(await roomRow().innerText()))
  await roomRow().getByRole('button', { name: 'Edit' }).click(); await page.waitForSelector('[data-testid=room-editor]')
  await page.getByTestId('room-archive').click(); await page.waitForSelector('[data-testid=archive-confirm]')
  await page.getByLabel(/^Reason/).fill('Closed for renovation'); await page.getByTestId('archive-confirm-button').click(); await page.waitForSelector('[data-testid=rooms-flash]:has-text("archived")', { timeout: 15000 })
  await page.waitForFunction(() => [...document.querySelectorAll('table[aria-label=Rooms] tbody tr')].some((r) => r.textContent.includes('Deluxe King') && r.getAttribute('data-active') === 'false'), null, { timeout: 15000 })
  await roomRow().getByRole('button', { name: 'Edit' }).click(); await page.waitForSelector('[data-testid=room-editor]')
  await page.getByLabel(/^Reason/).fill('Reopened after renovation'); await page.getByTestId('room-archive').click(); await page.waitForSelector('[data-testid=rooms-flash]:has-text("restored")', { timeout: 15000 })
  await page.waitForFunction(() => [...document.querySelectorAll('table[aria-label=Rooms] tbody tr')].some((r) => r.textContent.includes('Deluxe King') && r.getAttribute('data-active') === 'true'), null, { timeout: 15000 })
  check('archive keeps the room listed and restore makes it ACTIVE again', /ACTIVE/.test(await roomRow().innerText()))

  // ---- 4. Amenities and images ----
  await page.goto(`${BASE}/hotels/${hotelId}?tab=amenities`); await page.waitForSelector('[data-testid=amenities-form]')
  await page.getByLabel('Swimming pool', { exact: true }).check(); await page.getByLabel('Swimming pool fee').selectOption('FREE')
  await page.getByTestId('amenities-save').click(); await page.waitForSelector('[data-testid=amenities-flash]:has-text("Amenities saved")', { timeout: 15000 })
  await page.reload(); await page.waitForSelector('[data-testid=amenities-form]')
  check('hotel amenities save on the strict role, read back after a reload', await page.getByLabel('Swimming pool', { exact: true }).isChecked())
  await page.goto(`${BASE}/hotels/${hotelId}?tab=images`); await page.waitForSelector('[data-testid=hotel-images]')
  await page.getByTestId('image-file').setInputFiles({ name: 'lobby.png', mimeType: 'image/png', buffer: png(800, 600, [200, 30, 30]) }); await page.getByLabel('Alt text (required)').fill('Lobby')
  await page.getByTestId('image-upload-submit').click(); await page.waitForSelector('[data-testid=image-card]', { timeout: 15000 })
  const decoded = await page.waitForFunction(() => { const el = document.querySelector('[data-testid=image-card] img'); return !!el && el.complete && el.naturalWidth === 800 }, null, { timeout: 15000 }).then(() => true, () => false)
  check('an image uploads and the browser decodes the bytes served back on the strict role', decoded)

  // ---- 5. Completeness, then maker-checker publication ----
  await page.goto(`${BASE}/hotels/${hotelId}`); await page.waitForSelector('[data-testid=profile-completeness]', { timeout: 20000 })
  const summary = await page.getByTestId('completeness-summary').innerText()
  check('the API reports every publication requirement met', /can be published/.test(summary), summary)
  await page.goto(`${BASE}/hotels/${hotelId}?tab=setup`); await page.waitForSelector('[data-testid=publication]')
  await page.getByTestId('publication').getByLabel('Reason (required)').fill('Reviewed against the register'); await page.getByTestId('publication-request').click()
  await page.waitForSelector('[data-testid=publication-state]:has-text("PENDING")', { timeout: 15000 })
  check('the requester cannot approve their own publication request', (await page.getByTestId('publication-approve').count()) === 0)
  const checker = await login(browser, seed.checkerEmail); const cp = checker.page
  await cp.goto(`${BASE}/hotels/${hotelId}?tab=setup`); await cp.waitForSelector('[data-testid=publication-approve]', { timeout: 20000 })
  await cp.getByTestId('publication').getByLabel('Decision reason (required)').fill('Checked against the register'); await cp.getByTestId('publication-approve').click()
  await cp.waitForSelector('[data-testid=publication-execute]', { timeout: 15000 }); await checker.ctx.close()
  await page.reload(); await page.waitForSelector('[data-testid=publication-execute]', { timeout: 20000 }); await page.getByTestId('publication-execute').click()
  await page.waitForSelector('[data-testid=profile-status]:has-text("COMPLETE")', { timeout: 15000 })
  await page.goto(`${BASE}/hotels/${hotelId}`); await page.waitForSelector('[data-testid=overview-status]', { timeout: 20000 })
  check('after a second person approves, the hotel is published (COMPLETE)', (await page.getByTestId('overview-status').innerText()) === 'COMPLETE')

  // ---- 6. A privileged path is a typed 403, not a crash ----
  const refused = await page.evaluate(async (id) => { const r = await fetch(`/api/v1/supply/hotels/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalRef: 'privileged-column' }) }); return { status: r.status, body: await r.json().catch(() => ({})) } }, hotelId)
  check('a privileged column (hotel external_ref, supply authoring) answers a typed 403 with no database text', refused.status === 403 && refused.body.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && !/permission denied|42501|external_ref|Hotel"/.test(JSON.stringify(refused.body)), JSON.stringify(refused.body).slice(0, 120))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('FAIL  aborted:', String(e.message ?? e).split('\n')[0]); process.exit(1) })
