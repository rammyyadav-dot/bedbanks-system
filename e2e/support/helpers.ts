import { expect, type Page } from '@playwright/test'
import { ORIGINS } from './config'
import { loadState } from './stack'

export const ACCOUNTS = {
  admin: 'preview-admin@example.test',
  restricted: 'preview-restricted@example.test',
  agent: 'preview-agent@example.test',
  supplierEditor: 'preview-supplier-editor@example.test',
  supplierReader: 'preview-supplier-reader@example.test',
  supplierBeta: 'preview-supplier-beta@example.test',
  supplierRevoked: 'preview-supplier-revoked@example.test',
  tenantB: 'preview-tenant-b@example.test',
} as const
export type AccountKey = keyof typeof ACCOUNTS

export const fixtures = () => loadState().fixtures as Record<string, string>
export const passwordFor = (key: AccountKey): string => loadState().passwords[ACCOUNTS[key]]

/** ISO date `days` from today in UTC (the fixtures are seeded against UTC dates). */
export function isoDay(days: number): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days)).toISOString().slice(0, 10)
}

export async function signInAgent(page: Page, key: AccountKey = 'agent'): Promise<void> {
  await page.goto(`${ORIGINS.agent}/login`)
  await page.locator('input[type=email]').fill(ACCOUNTS[key])
  await page.locator('input[type=password]').fill(passwordFor(key))
  await page.getByRole('button', { name: /agent sign in/i }).click()
  await expect(page.getByText('Search hotel inventory')).toBeVisible()
}

export async function signInAdmin(page: Page, key: AccountKey = 'admin'): Promise<void> {
  await page.goto(`${ORIGINS.admin}/login`)
  await page.getByLabel('Work email').fill(ACCOUNTS[key])
  await page.getByLabel('Password').fill(passwordFor(key))
  await page.getByRole('button', { name: /sign in securely/i }).click()
  await page.waitForURL(/\/dashboard/) // sign-in is complete only once the session cookie is set and the dashboard loads
}

export async function signInSupplier(page: Page, key: AccountKey = 'supplierEditor'): Promise<void> {
  await page.goto(`${ORIGINS.supplier}/login`)
  await page.getByLabel('Email').fill(ACCOUNTS[key])
  await page.getByLabel('Password').fill(passwordFor(key))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(/\/dashboard/)
}
