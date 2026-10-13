import { expect, test } from '@playwright/test'
import { day, readState } from '../support/seed'
import { chooseOption, newPerson, signIn, withDb } from '../support/session'

/**
 * The whole path a hotel contracts manager takes to put a new price on sale, in a real browser against the real API and database:
 * create the plan, price it from another plan, add a promotion, review the checklist, ask for activation, and have a SECOND person approve and
 * activate it. Nothing sells until that second person acts.
 */
test.describe.serial('guided rate plan setup, derived price and four-eye activation', () => {
  const state = readState()
  const code = `GUIDED-${state.suffix}`.toUpperCase()
  let planId = ''

  test('the operator creates the plan and lands in the guided setup', async ({ page }) => {
    await signIn(page, state.operator)
    await page.goto('/rates/plans/new')
    await chooseOption(page.getByLabel('Contract', { exact: true }), state.contractCode)
    await expect(page.getByLabel(/^Hotel/)).toHaveValue(state.hotelId)
    await chooseOption(page.getByLabel('Room type'), state.roomName)
    await chooseOption(page.getByLabel('Board basis'), 'BB')
    await page.getByLabel('Rate plan code').fill(code)
    await page.getByRole('button', { name: 'Create rate plan' }).click()
    await expect(page).toHaveURL(/\/rates\/plans\/[^/]+\/setup$/)
    planId = page.url().split('/').at(-2)!
    await expect(page.getByRole('heading', { name: 'Guided setup' })).toBeVisible()
    // a new plan has no rates, so the setup lands on the first step with something left to do
    await expect(page.locator('[data-step="pricing"]')).toHaveAttribute('data-state', 'attention')
  })

  test('the plan is priced from the active parent plan, by a percentage', async ({ page }) => {
    await signIn(page, state.operator)
    await page.goto(`/rates/plans/${planId}/setup`)
    await page.locator('[data-step="pricing"]').click()
    await chooseOption(page.getByLabel('Parent rate plan'), state.parentPlanCode)
    await page.getByLabel('Adjustment', { exact: true }).fill('-10')
    await page.getByRole('button', { name: 'Derive this plan' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Derived pricing saved' })).toBeVisible()
    await expect(page.getByText(/10% below/)).toBeVisible()
    // it has no rates of its own; its stock is its own, so the hotel loads availability for the nights it sells
    await withDb((db) => db.dailyAvailability.createMany({ data: Array.from({ length: 75 }, (_, i) => ({ tenantId: state.tenantId, ratePlanId: planId, stayDate: new Date(day(-5 + i)), allotment: 3 })) }))
    expect(await withDb((db) => db.dailyRate.count({ where: { ratePlanId: planId } }))).toBe(0)
  })

  test('a promotion is added, and bad input is stopped before it reaches the server', async ({ page }) => {
    await signIn(page, state.operator)
    await page.goto(`/rates/plans/${planId}/setup`)
    await page.locator('[data-step="extras"]').click()
    await page.getByRole('button', { name: 'Add promotion' }).click()
    await page.getByLabel('Kind').selectOption('LONG_STAY')
    await page.getByLabel('Promotion 1 name').fill('Stay 3 save 10')
    await page.getByLabel('Promotion 1 discount percent').fill('95')
    await page.getByLabel('Promotion 1 minimum nights').fill('3')
    await page.getByRole('button', { name: 'Save promotions' }).click()
    await expect(page.getByRole('alert').filter({ hasText: /0.01 to 90 percent/ })).toBeVisible()
    await page.getByLabel('Promotion 1 discount percent').fill('10')
    await page.getByRole('button', { name: 'Save promotions' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Promotions saved' })).toBeVisible()
    const stored = await withDb((db) => db.ratePlanPromotion.findMany({ where: { ratePlanId: planId } }))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ kind: 'LONG_STAY', name: 'Stay 3 save 10', percentBp: 1000, minNights: 3 })
  })

  test('the review shows every check passing and the operator asks for activation', async ({ page }) => {
    await signIn(page, state.operator)
    await page.goto(`/rates/plans/${planId}/setup`)
    await page.locator('[data-step="review"]').click()
    await expect(page.locator('[data-check][data-ok="false"]')).toHaveCount(0)
    await expect(page.locator('[data-check="DERIVED_PARENT_VALID"]')).toHaveAttribute('data-ok', 'true')
    await expect(page.locator('[data-check="PROMOTIONS_VALID"]')).toHaveAttribute('data-ok', 'true')
    await page.locator('[data-action="request-activation"]').click()
    const panel = page.getByRole('region', { name: new RegExp(`activation approval ${code}`, 'i') })
    await panel.getByLabel('Request reason').fill('Corporate net rate agreed with the hotel')
    await panel.getByRole('button', { name: 'Request activation' }).click()
    await expect(panel.getByTestId('approval-stage')).toHaveAttribute('data-stage', 'awaiting-other')
    // the requester cannot approve their own request, and nothing is on sale yet
    expect(await withDb((db) => db.ratePlan.findUniqueOrThrow({ where: { id: planId } }))).toMatchObject({ status: 'DRAFT' })
  })

  test('a different person approves and activates; only then is the plan live', async ({ browser }) => {
    const approver = await newPerson(browser, state.approver)
    await approver.goto(`/rates/plans/${planId}/setup`)
    await approver.locator('[data-step="review"]').click()
    await approver.locator('[data-action="request-activation"]').click()
    const panel = approver.getByRole('region', { name: new RegExp(`activation approval ${code}`, 'i') })
    await expect(panel.getByTestId('approval-stage')).toHaveAttribute('data-stage', 'decide')
    await expect(panel.getByText(/Corporate net rate agreed with the hotel/)).toBeVisible()
    await panel.getByLabel('Decision reason').fill('Rates and terms checked against the contract')
    await panel.getByRole('button', { name: 'Approve' }).click()
    await expect(panel.getByTestId('approval-stage')).toHaveAttribute('data-stage', 'execute')
    await panel.getByRole('button', { name: 'Activate now' }).click()
    await expect.poll(() => withDb((db) => db.ratePlan.findUniqueOrThrow({ where: { id: planId } }).then((p) => p.status))).toBe('ACTIVE')
    const audit = await withDb((db) => db.auditEvent.findMany({ where: { tenantId: state.tenantId, entityId: planId }, select: { action: true } }))
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['supply.rate_plan.derivation_changed', 'supply.rate_plan.promotions_changed']))
    await approver.context().close()
  })
})
