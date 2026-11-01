import { BadRequestException } from '@nestjs/common'
import { SupplyService } from './supply.service'

/** ADR 0035: the supply write path normalizes and validates contract sales-market and nationality lists before they reach the database. */
describe('contract sales-market and nationality write validation', () => {
  const stored: Array<Record<string, unknown>> = []
  const tx = { supplier: { findFirst: async () => ({ id: 's' }) }, contract: { create: async ({ data }: { data: Record<string, unknown> }) => { stored.push(data); return { id: 'c', ...data } } } }
  const service = new SupplyService(null as never, null as never)
  jest.spyOn(service as never, 'write').mockImplementation((async (...args: unknown[]) => (args[6] as (t: unknown) => Promise<{ value: unknown }>)(tx)) as never)
  const create = (extra: Record<string, unknown>) => service.createContract('t', 'u', { supplierId: 's', code: 'C1', validFrom: '2030-01-01', validTo: '2030-12-31', settlementCurrency: 'AED', ...extra })

  beforeEach(() => { stored.length = 0 })

  it('stores normalized codes and an empty list when none is given', async () => {
    await create({ salesMarkets: [' gb', 'DE', 'gb'], nationalities: ['fr'] })
    await create({})
    expect(stored[0]).toMatchObject({ salesMarkets: ['DE', 'GB'], nationalities: ['FR'] })
    expect(stored[1]).toMatchObject({ salesMarkets: [], nationalities: [] })
  })

  it.each([['salesMarkets', 'junk'], ['salesMarkets', ['GBR']], ['nationalities', [1]], ['nationalities', { a: 1 }]])('refuses %s = %p with 400 and stores nothing', async (field, value) => {
    await expect(create({ [field]: value })).rejects.toBeInstanceOf(BadRequestException)
    expect(stored).toHaveLength(0)
  })
})
