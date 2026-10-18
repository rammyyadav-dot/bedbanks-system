import { retrieveHotelCandidates } from './hotel-search-index'

function fakeTx(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows)
  return { tx: { $queryRaw: queryRaw } as never, queryRaw }
}

describe('retrieveHotelCandidates (hybrid RRF)', () => {
  it('runs one query that fuses vector, trigram and full-text ranks, scoped to the tenant in every retriever', async () => {
    const { tx, queryRaw } = fakeTx([{ hotelId: 'h1', vectorSimilarity: 0.9, nameSimilarity: 0.8, textRank: 0.1, fusedScore: 0.05 }])
    const rows = await retrieveHotelCandidates(tx, 'tenant_a', { name: 'Atlantis The Palm', city: 'Dubai', countryCode: 'ae' })
    expect(rows).toHaveLength(1)
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]]
    const sql = strings.join('?')
    expect(sql).toContain('vector_ranked')
    expect(sql).toContain('trigram_ranked')
    expect(sql).toContain('text_ranked')
    expect(sql).toContain('"search_tsv" @@')
    expect(sql.match(/"tenant_id" = \?/g)?.length).toBeGreaterThanOrEqual(4)
    expect(values).toContain('tenant_a')
    expect(values).toContain('AE')
    expect(values).toContain(60)
  })
})
