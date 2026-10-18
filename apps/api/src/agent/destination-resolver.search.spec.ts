import { DestinationResolverService } from './destination-resolver.service'
import { NoopCache } from '../common/cache/cache.port'

function build(rows: unknown[]) {
  const calls: string[] = []
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(`exec:${strings.join('?')}|${values.join(',')}`); return 1 }),
    $queryRaw: jest.fn(async (query: { sql: string }) => { calls.push(`query:${query.sql}`); return rows }),
  }
  const prisma = { withTenant: async (_tenant: string, run: (tx: unknown) => unknown) => run(tx) }
  return { service: new DestinationResolverService(prisma as never, new NoopCache()), calls }
}

describe('DestinationResolverService.search', () => {
  it('sets the transaction-local trigram threshold before an index-friendly query', async () => {
    const { service, calls } = build([{ id: 'h1', name: 'Atlantis The Palm', city: 'Dubai', countryCode: 'AE', citySim: 1, nameSim: 0.1 }])
    const result = await service.search('t1', 'Dubia')
    expect(calls[0]).toContain('pg_trgm.word_similarity_threshold')
    expect(calls[0]).toContain('0.35')
    expect(calls[1]).toContain('<%')
    expect(calls[1]).not.toMatch(/word_similarity\([^)]*\)\s*>=/)
    expect(result.some((item) => item.type === 'city' && item.name === 'Dubai')).toBe(true)
  })
})
