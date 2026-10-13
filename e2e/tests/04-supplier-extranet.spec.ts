import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { signInSupplier } from '../support/helpers'

test.describe('Supplier extranet: members see only their own organisation', () => {
  test('X1 anonymous visitors are sent to sign-in', async ({ page }) => {
    await page.goto(`${ORIGINS.supplier}/hotels`)
    await expect(page).toHaveURL(/\/login/)
  })

  test('X2 wrong password is refused', async ({ page }) => {
    await page.goto(`${ORIGINS.supplier}/login`)
    await page.getByLabel('Email').fill('preview-supplier-editor@example.test')
    await page.getByLabel('Password').fill('not-the-password-123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Invalid email or password.')).toBeVisible()
  })

  test('X3 the Alpha editor sees Alpha’s hotel only, and the workspace states what is not available', async ({ page, context }) => {
    await signInSupplier(page, 'supplierEditor')
    await expect(page.getByText('Preview Supplier Alpha').first()).toBeVisible()
    await expect(page.getByText('Publication and booking are unavailable')).toBeVisible()
    const session = (await context.cookies(ORIGINS.supplier)).find((c) => c.name === 'fbeds_session')!
    expect(session.httpOnly).toBe(true)
    expect(session.secure).toBe(true)
    await page.goto(`${ORIGINS.supplier}/hotels`)
    await expect(page.getByText('Preview Marina Dubai')).toBeVisible()
    await expect(page.getByText('Preview Creek Dubai')).toHaveCount(0)
  })

  test('X4 the read-only member sees the same hotel list', async ({ page }) => {
    await signInSupplier(page, 'supplierReader')
    await page.goto(`${ORIGINS.supplier}/hotels`)
    await expect(page.getByText('Preview Marina Dubai')).toBeVisible()
  })

  test('X5 Beta sees Beta’s hotel and never Alpha’s', async ({ page }) => {
    await signInSupplier(page, 'supplierBeta')
    await page.goto(`${ORIGINS.supplier}/hotels`)
    await expect(page.getByText('Preview Creek Dubai')).toBeVisible()
    await expect(page.getByText('Preview Marina Dubai')).toHaveCount(0)
  })

  test('X6 a revoked member signs in but sees no organisation and no hotels', async ({ page }) => {
    await signInSupplier(page, 'supplierRevoked')
    await expect(page.getByText('Membership required')).toBeVisible()
    await page.goto(`${ORIGINS.supplier}/hotels`)
    await expect(page.getByText('No supplier organization is available for this account.')).toBeVisible()
    await expect(page.getByText('Preview Marina Dubai')).toHaveCount(0)
    await expect(page.getByText('Preview Creek Dubai')).toHaveCount(0)
  })
})
