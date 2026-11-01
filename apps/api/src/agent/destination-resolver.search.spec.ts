import { DestinationResolverService } from './destination-resolver.service'
import { NoopCache } from '../common/cache/cache.port'

interface Rows { prefixCities?: unknown[]; prefixHotels?: unknown[]; scan?: unknown[] }

function build({ prefixCities = [], prefixHotels = [], scan = [] }: Rows) {
  const calls: string[] = []
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(`exec:${strings.join('?')}|${values.join(',')}`); return 1 }),
    $queryRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      calls.push(`query:${query.sql}|${query.values.join(',')}`)
      if (query.sql.includes('"city_key"')) return prefixCities
      if (query.sql.includes('"name_key"')) return prefixHotels
      return scan
    }),
  }
  const prisma = { withTenant: async (_tenant: string, run: (tx: unknown) => unknown) => run(tx) }
  return { service: new DestinationResolverService(prisma as never, new NoopCache()), calls }
}

const scanCalls = (calls: string[]) => calls.filter((call) => call.includes('<%'))

describe('DestinationResolverService.search', () => {
  it('answers a prefix from the key-range indexes without the substring/trigram scan', async () => {
    const { service, calls } = build({
      prefixCities: [{ city: 'Dubai', countryCode: 'AE' }],
      prefixHotels: [{ id: 'h1', name: 'Dubai Marina Hotel', city: 'Dubai', countryCode: 'AE' }],
    })
    const result = await service.search('t1', 'Dub')
    expect(result).toEqual([
      expect.objectContaining({ type: 'city', name: 'Dubai', countryCode: 'AE' }),
      expect.objectContaining({ type: 'hotel', id: 'h1', name: 'Dubai Marina Hotel' }),
    ])
    expect(scanCalls(calls)).toHaveLength(0)
    expect(calls.some((call) => call.startsWith('exec:'))).toBe(false)
  })

  it('compares with COLLATE "C" and a tenant predicate, using leakproof range operators only', async () => {
    const { service, calls } = build({ prefixCities: [{ city: 'Paris', countryCode: 'FR' }], prefixHotels: [{ id: 'h', name: 'Paris Inn', city: 'Paris', countryCode: 'FR' }] })
    await service.search('t1', 'Par')
    for (const call of calls.filter((c) => c.startsWith('query:'))) {
      expect(call).toContain('COLLATE "C") >=')
      expect(call).toContain('COLLATE "C") <')
      expect(call).toContain('"tenant_id" =')
      expect(call).not.toMatch(/LIKE|<%|lower\(/)
      expect(call.split('|')[1]).toContain('t1,par,par\u{10FFFF}')
    }
  })

  it('falls back to the trigram scan for a typo, setting the transaction-local threshold first', async () => {
    const { service, calls } = build({ scan: [{ id: 'h1', name: 'Atlantis The Palm', city: 'Dubai', countryCode: 'AE', citySim: 1, nameSim: 0.1 }] })
    const result = await service.search('t1', 'Dubia')
    const exec = calls.findIndex((call) => call.startsWith('exec:') && call.includes('pg_trgm.word_similarity_threshold'))
    const scan = calls.findIndex((call) => call.includes('<%'))
    expect(exec).toBeGreaterThanOrEqual(0)
    expect(exec).toBeLessThan(scan)
    expect(calls[exec]).toContain('0.35')
    expect(calls[scan]).not.toMatch(/word_similarity\([^)]*\)\s*>=/)
    expect(result.some((item) => item.type === 'city' && item.name === 'Dubai')).toBe(true)
  })

  it('scans only to fill a category with no prefix hit and keeps the prefix hits for the other', async () => {
    const { service } = build({
      prefixCities: [{ city: 'Palma', countryCode: 'ES' }],
      scan: [{ id: 'h9', name: 'Grand Palm Resort', city: 'Dubai', countryCode: 'AE', citySim: 0.1, nameSim: 1 }],
    })
    const result = await service.search('t1', 'palm')
    expect(result.filter((item) => item.type === 'city').map((item) => item.name)).toEqual(['Palma'])
    expect(result.filter((item) => item.type === 'hotel').map((item) => item.id)).toEqual(['h9'])
  })

  it('escapes LIKE metacharacters in the fallback pattern', async () => {
    const { service, calls } = build({})
    await service.search('t1', '50%_off')
    expect(calls.find((call) => call.includes('<%'))).toContain('%50\\%\\_off%')
  })
})
