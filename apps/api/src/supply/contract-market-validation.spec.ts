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

  describe('source market groups & contract market validity rules (ADR 0107)', () => {
    it('upserts normalized source market groups and rejects invalid codes or countries', async () => {
      const upserted: Array<Record<string, unknown>> = []
      const groupTx = {
        sourceMarketGroup: {
          upsert: async (arg: Record<string, unknown>) => {
            upserted.push(arg)
            return { id: 'grp-1', ...(arg.create as Record<string, unknown>) }
          },
        },
      }
      jest.spyOn(service as never, 'write').mockImplementationOnce((async (...args: unknown[]) => (args[6] as (t: unknown) => Promise<{ value: unknown }>)(groupTx)) as never)

      const res = (await service.upsertSourceMarketGroup('t1', 'u1', {
        code: ' gcc ',
        name: 'Gulf Cooperation Council',
        countryCodes: ['ae', 'SA', 'qa', 'AE'],
      })) as unknown as { value: Record<string, unknown> }
      expect(res.value).toMatchObject({
        tenantId: 't1',
        code: 'GCC',
        name: 'Gulf Cooperation Council',
        countryCodes: ['AE', 'QA', 'SA'],
        isActive: true,
      })

      await expect(service.upsertSourceMarketGroup('t1', 'u1', { code: 'x', name: 'Bad', countryCodes: ['AE'] })).rejects.toBeInstanceOf(BadRequestException)
      await expect(service.upsertSourceMarketGroup('t1', 'u1', { code: 'GCC', name: 'Bad', countryCodes: [] })).rejects.toBeInstanceOf(BadRequestException)
    })

    it('creates and replaces contract market validity rules with tenant and rate plan validation', async () => {
      const createdRules: Array<Record<string, unknown>> = []
      const validityTx = {
        contract: { findFirst: async () => ({ id: 'c1', status: 'DRAFT' }) },
        ratePlan: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'rp1' ? { id: 'rp1' } : null) },
        sourceMarketGroup: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'grp-gcc' ? { id: 'grp-gcc' } : null) },
        marketValidityRule: {
          count: async () => 0,
          deleteMany: async () => ({ count: 0 }),
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `rule-${createdRules.length + 1}`, ...data, marketGroup: null }
            createdRules.push(row)
            return row
          },
          findMany: async () => createdRules,
        },
      }
      jest.spyOn(service as never, 'write').mockImplementation((async (...args: unknown[]) => (args[6] as (t: unknown) => Promise<{ value: unknown }>)(validityTx)) as never)

      const batch = (await service.upsertContractMarketValidity('t1', 'u1', 'c1', {
        rules: [
          { inclusionType: 'INCLUDE', matchType: 'MARKET_GROUP', marketGroupId: 'grp-gcc' },
          { ratePlanId: 'rp1', inclusionType: 'EXCLUDE', matchType: 'COUNTRY_CODE', countryCodes: ['in', 'gb'] },
        ],
      })) as unknown as { value: unknown[] }
      expect(batch.value).toHaveLength(2)
      expect(createdRules[0]).toMatchObject({
        tenantId: 't1',
        contractId: 'c1',
        ratePlanId: null,
        inclusionType: 'INCLUDE',
        matchType: 'MARKET_GROUP',
        marketGroupId: 'grp-gcc',
      })
      expect(createdRules[1]).toMatchObject({
        tenantId: 't1',
        contractId: 'c1',
        ratePlanId: 'rp1',
        inclusionType: 'EXCLUDE',
        matchType: 'COUNTRY_CODE',
        countryCodes: ['GB', 'IN'],
      })

      await expect(
        service.upsertContractMarketValidity('t1', 'u1', 'c1', {
          ratePlanId: 'rp-other-contract',
          inclusionType: 'INCLUDE',
          matchType: 'COUNTRY_CODE',
          countryCodes: ['AE'],
        })
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  })
})
