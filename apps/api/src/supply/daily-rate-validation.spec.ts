import { BadRequestException } from '@nestjs/common'
import { SupplyService } from './supply.service'

/** ADR 0034: the supply write path refuses a zero or negative rate before it reaches the database. */
describe('upsertDailyRate amount validation', () => {
  const service = new SupplyService(null as never, null as never)
  const input = (amountMinor: unknown) => ({ ratePlanId: 'plan', stayDate: '2030-01-01', occupancy: 2, amountMinor, amountBasis: 'SELL' })

  it.each([0, '0', -1, '-1'])('refuses %p with 400 and touches nothing', async (amount) => {
    await expect(service.upsertDailyRate('tenant', 'user', input(amount))).rejects.toBeInstanceOf(BadRequestException)
  })
})
