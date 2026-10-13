import { expect, type Browser, type Locator, type Page } from '@playwright/test'
import { PASSWORD } from './seed'
import { PrismaClient } from './db'

/** Signs a person in through the real sign-in page and waits until the console has opened. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** A second, independent browser session: another person on another machine. */
export async function newPerson(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, email)
  return page
}

/** Owner connection for arranging and observing only. The journeys act through the browser. */
export async function withDb<T>(work: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ datasourceUrl: process.env.E2E_DATABASE_URL })
  try { return await work(prisma) } finally { await prisma.$disconnect() }
}

/** Picks the option whose text contains `text` (option labels carry more than the code), then checks it really is the selected one. */
export async function chooseOption(select: Locator, text: string): Promise<void> {
  const option = select.locator('option', { hasText: text }).first()
  await expect(option).toBeAttached()
  const value = await option.getAttribute('value')
  expect(value).toBeTruthy()
  await select.selectOption(value as string)
  await expect(select).toHaveValue(value as string)
}
