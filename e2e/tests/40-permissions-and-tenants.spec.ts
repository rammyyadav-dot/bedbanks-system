import { expect, test } from '@playwright/test'
import { readState } from '../support/seed'
import { signIn, withDb } from '../support/session'

/** Who may do what, and who may see whose data. The server enforces every rule; these journeys prove a person in a browser meets them. */
test.describe('permissions and tenant isolation', () => {
  const state = readState()

  test('a read-only user can look at a plan but is offered no way to change it', async ({ page }) => {
    await signIn(page, state.readonly)
    await page.goto(`/rates/plans/${state.parentPlanId}`)
    await expect(page.getByLabel('Rate plan code')).toHaveValue(state.parentPlanCode)
    await expect(page.getByRole('button', { name: 'Save rate plan' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save promotions' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Derive this plan|Save derived pricing/ })).toHaveCount(0)
  })

  test('a read-only user who forces a change through the API is refused and nothing is written', async ({ page }) => {
    await signIn(page, state.readonly)
    await page.goto(`/rates/plans/${state.parentPlanId}`)
    const before = await withDb((db) => db.ratePlanPromotion.count({ where: { ratePlanId: state.parentPlanId } }))
    const response = await page.evaluate(async (planId) => {
      const read = await fetch(`/api/v1/supply/rate-plans/${planId}/promotions`, { credentials: 'include' }).then((r) => r.json())
      const put = await fetch(`/api/v1/supply/rate-plans/${planId}/promotions`, {
        method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: read.data.updatedAt, promotions: [] }),
      })
      return put.status
    }, state.parentPlanId)
    expect(response).toBe(403)
    expect(await withDb((db) => db.ratePlanPromotion.count({ where: { ratePlanId: state.parentPlanId } }))).toBe(before)
  })

  test("another company's operator cannot open this company's plan, by page or by API", async ({ page }) => {
    await signIn(page, state.outsider)
    await page.goto(`/rates/plans/${state.parentPlanId}`)
    await expect(page.getByLabel('Rate plan code')).toHaveCount(0)
    const status = await page.evaluate(async (planId) => (await fetch(`/api/v1/supply/rate-plans/${planId}`, { credentials: 'include' })).status, state.parentPlanId)
    expect([403, 404]).toContain(status)
    const promotions = await page.evaluate(async (planId) => (await fetch(`/api/v1/supply/rate-plans/${planId}/promotions`, { credentials: 'include' })).status, state.parentPlanId)
    expect([403, 404]).toContain(promotions)
  })

  test('the person who asked for an activation cannot approve it', async ({ page }) => {
    // arrange a ready draft and a pending request in the database, as the requester would have filed it
    const code = `OWN-${state.suffix}`.toUpperCase()
    await withDb(async (db) => {
      const plan = await db.ratePlan.create({ data: { tenantId: state.tenantId, contractId: state.contractId, roomTypeId: state.roomId, boardBasisId: state.boardId, code, status: 'DRAFT', refundable: true, occupancy: 2, currency: 'AED' } })
      const nights = Array.from({ length: 30 }, (_, i) => new Date(Date.now() + (i - 2) * 86_400_000))
      await db.dailyRate.createMany({ data: nights.map((d) => ({ tenantId: state.tenantId, ratePlanId: plan.id, stayDate: new Date(d.toISOString().slice(0, 10)), occupancy: 2, amountMinor: 40_000n, amountBasis: 'NET' as const, currency: 'AED' })) })
      await db.dailyAvailability.createMany({ data: nights.map((d) => ({ tenantId: state.tenantId, ratePlanId: plan.id, stayDate: new Date(d.toISOString().slice(0, 10)), allotment: 2 })) })
    })
    const planId = await withDb(async (db) => (await db.ratePlan.findFirstOrThrow({ where: { code, tenantId: state.tenantId } })).id)
    await signIn(page, state.operator)
    await page.goto(`/rates/plans/${planId}/setup`)
    await page.locator('[data-step="review"]').click()
    await page.locator('[data-action="request-activation"]').click()
    const panel = page.getByRole('region', { name: new RegExp(`activation approval ${code}`, 'i') })
    await panel.getByLabel('Request reason').fill('Needs a second pair of eyes')
    await panel.getByRole('button', { name: 'Request activation' }).click()
    await expect(panel.getByTestId('approval-stage')).toHaveAttribute('data-stage', 'awaiting-other')
    await expect(panel.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Activate now' })).toHaveCount(0)
    expect((await withDb((db) => db.ratePlan.findUniqueOrThrow({ where: { id: planId } }))).status).toBe('DRAFT')
  })
})
