import { runHotelSearchReindex } from './hotel-search-reindex'

const hotel = (id: string, countryCode = 'AE') => ({ id, name: `Hotel ${id}`, address: 'Main St', city: 'Dubai', countryCode, latitude: null, longitude: null })

function build(pages: Array<ReturnType<typeof hotel>[]>) {
  const writes: string[] = []
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => { if (strings.join('').includes('INSERT INTO "HotelSearchIndex"')) writes.push('upsert'); return 1 }),
    $queryRaw: jest.fn(async () => pages.shift() ?? []),
  }
  const prisma = { tenant: { findMany: jest.fn(async () => [{ id: 't1' }]) }, $transaction: async (run: (t: unknown) => unknown) => run(tx) }
  return { prisma: prisma as never, writes }
}

describe('runHotelSearchReindex', () => {
  it('writes nothing on a dry run but reports the stale hotels', async () => {
    const { prisma, writes } = build([[hotel('a'), hotel('b')]])
    const report = await runHotelSearchReindex(prisma, { apply: false })
    expect(report.mode).toBe('dry-run')
    expect(report.totals).toEqual({ stale: 2, applied: 0, skippedInvalid: 0 })
    expect(writes).toHaveLength(0)
  })

  it('upserts every indexable hotel across batches and reconciles', async () => {
    const { prisma, writes } = build([[hotel('a'), hotel('b')], [hotel('c')]])
    const report = await runHotelSearchReindex(prisma, { apply: true, batchSize: 2, tenantIds: ['t1'] })
    expect(report.totals).toEqual({ stale: 3, applied: 3, skippedInvalid: 0 })
    expect(report.reconciliation.appliedEqualsIndexable).toBe(true)
    expect(writes).toHaveLength(3)
  })

  it('skips hotels without a country code and reports their ids', async () => {
    const { prisma, writes } = build([[hotel('a'), hotel('x', '')]])
    const report = await runHotelSearchReindex(prisma, { apply: true, tenantIds: ['t1'] })
    expect(report.tenants[0].skippedInvalid).toEqual(['x'])
    expect(report.totals.applied).toBe(1)
    expect(report.reconciliation.appliedEqualsIndexable).toBe(true)
    expect(writes).toHaveLength(1)
  })
})
