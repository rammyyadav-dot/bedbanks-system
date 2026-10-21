import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ORIGINS } from '../support/config'
import { isoDay, passwordFor, ACCOUNTS } from '../support/helpers'

const OUT = join(__dirname, '../.artifacts/agent-portal-screens')
mkdirSync(OUT, { recursive: true })

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto(`${ORIGINS.agent}/login`)
  await page.screenshot({ path: join(OUT, '01-login.png') })

  await page.locator('input[type=email]').fill(ACCOUNTS.agent)
  await page.locator('input[type=password]').fill(passwordFor('agent'))
  await page.getByRole('button', { name: /agent sign in/i }).click()
  await page.getByText('Search hotel inventory').waitFor()
  await page.screenshot({ path: join(OUT, '02-workspace.png') })

  const destination = page.getByPlaceholder('Search destinations & hotels…')
  await destination.click()
  await destination.fill('Dubai')
  await page.getByRole('option', { name: /^Dubai City/ }).click()
  await page.screenshot({ path: join(OUT, '03-destination-picked.png') })

  await page.getByRole('button', { name: /nights/ }).first().click()
  await page.getByRole('button', { name: isoDay(14), exact: true }).and(page.locator(':enabled')).first().click()
  await page.getByRole('button', { name: isoDay(16), exact: true }).and(page.locator(':enabled')).first().click()
  await page.screenshot({ path: join(OUT, '04-dates-picked.png') })
  await page.getByRole('button', { name: 'Apply dates' }).click()

  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByText('Preview Creek Dubai').first().waitFor({ timeout: 30_000 })
  await page.screenshot({ path: join(OUT, '05-search-results.png'), fullPage: true })

  await page.getByRole('button', { name: 'View rooms' }).first().click()
  await page.screenshot({ path: join(OUT, '06-room-compare.png'), fullPage: true })

  await page.getByRole('button', { name: 'Select Offer' }).first().click()
  await page.getByText('Offer rechecked').waitFor({ timeout: 20_000 })
  await page.screenshot({ path: join(OUT, '07-offer-rechecked.png'), fullPage: true })

  await page.getByText('Preview Agent', { exact: true }).click()
  await page.screenshot({ path: join(OUT, '08-profile-menu.png') })
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.getByRole('button', { name: /agent sign in/i }).waitFor()
  await page.screenshot({ path: join(OUT, '09-signed-out.png') })

  await browser.close()
  console.log(`Screenshots written to ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
