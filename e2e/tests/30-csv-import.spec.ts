import { expect, test } from '@playwright/test'
import { day, readState } from '../support/seed'
import { signIn, withDb } from '../support/session'

/**
 * Loading a rate sheet the way a hotel contracts team actually does: paste a CSV, see exactly which rows are accepted and which are not, acknowledge
 * the rejected ones, and apply the accepted ones in one step. Money is read as integer minor units; a malformed row is never guessed at.
 */
test.describe.serial('CSV rate import', () => {
  const state = readState()
  const code = `IMPORT-${state.suffix}`.toUpperCase()
  let planId = ''

  test.beforeAll(async () => {
    planId = await withDb(async (db) => (await db.ratePlan.create({ data: { tenantId: state.tenantId, contractId: state.contractId, roomTypeId: state.roomId, boardBasisId: state.boardId, code, status: 'DRAFT', refundable: true, occupancy: 2, currency: 'AED' } })).id)
  })

  test('good rows are accepted, a bad row is rejected and must be acknowledged, then everything accepted is applied together', async ({ page }) => {
    await signIn(page, state.operator)
    await page.goto(`/hotels/${state.hotelId}?tab=rates`)
    await page.getByText('Import rates and availability from a CSV file').click()
    const csv = [
      'plan_code,date,amount,basis,allotment,stop_sell,min_stay',
      `${code},${day(20)},450.50,NET,4,false,1`,
      `${code},${day(21)},450.50,NET,4,false,1`,
      `${code},${day(22)},not-a-price,NET,4,false,1`,
      `${code},${day(23)},500,NET,4,false,2`,
    ].join('\n')
    await page.getByLabel('CSV text').fill(csv)
    await page.getByRole('button', { name: 'Check file' }).click()
    const result = page.getByTestId('import-result')
    await expect(result).toContainText('3 of 4 rows accepted')
    await expect(result).toContainText('1 rejected')
    await expect(result.getByRole('table', { name: 'Rejected rows' })).toBeVisible()
    // nothing is written by checking
    expect(await withDb((db) => db.dailyRate.count({ where: { ratePlanId: planId } }))).toBe(0)
    const apply = result.getByRole('button', { name: /^Apply \d+ accepted cell/ })
    await expect(apply).toBeDisabled()
    await result.getByRole('checkbox').check()
    await expect(apply).toBeEnabled()
    await apply.click()
    await expect(page.getByRole('status').filter({ hasText: /Applied \d+ cell\(s\) atomically/ })).toBeVisible()
    const rates = await withDb((db) => db.dailyRate.findMany({ where: { ratePlanId: planId }, orderBy: { stayDate: 'asc' } }))
    expect(rates.map((r) => [r.stayDate.toISOString().slice(0, 10), r.amountMinor, r.amountBasis, r.currency])).toEqual([[day(20), 45050n, 'NET', 'AED'], [day(21), 45050n, 'NET', 'AED'], [day(23), 50000n, 'NET', 'AED']])
    const stock = await withDb((db) => db.dailyAvailability.findMany({ where: { ratePlanId: planId }, orderBy: { stayDate: 'asc' } }))
    expect(stock.map((s) => [s.stayDate.toISOString().slice(0, 10), s.allotment, s.minStay])).toEqual([[day(20), 4, 1], [day(21), 4, 1], [day(23), 4, 2]])
    // and every written cell is on the audit trail: three prices and three availability rows
    expect(await withDb((db) => db.auditEvent.count({ where: { tenantId: state.tenantId, action: 'supply.daily_rate.updated' } }))).toBe(3)
    expect(await withDb((db) => db.auditEvent.count({ where: { tenantId: state.tenantId, action: 'supply.availability.updated' } }))).toBe(3)
  })

  test('a file that names no known plan is refused as a whole and writes nothing', async ({ page }) => {
    await signIn(page, state.operator)
    await page.goto(`/hotels/${state.hotelId}?tab=rates`)
    await page.getByText('Import rates and availability from a CSV file').click()
    await page.getByLabel('CSV text').fill(['plan_code,date,amount,basis', `NO-SUCH-PLAN,${day(30)},100,NET`].join('\n'))
    await page.getByRole('button', { name: 'Check file' }).click()
    await expect(page.getByTestId('import-result')).toContainText('0 of 1 rows accepted')
    await expect(page.getByTestId('import-result').getByRole('button', { name: /^Apply/ })).toHaveCount(0)
    expect(await withDb((db) => db.dailyRate.count({ where: { tenantId: state.tenantId, amountMinor: 10_000n } }))).toBe(0)
  })
})
