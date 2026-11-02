import { retrieveHotelCandidates } from './hotel-search-index'

function fakeTx(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows)
  return { tx: { $queryRaw: queryRaw } as never, queryRaw }
}

function sqlText(call: unknown[]): { sql: string; values: unknown[] } {
  const arg = call[0] as { strings?: string[]; values?: unknown[] } | string[]
  if (Array.isArray(arg)) {
    return { sql: (arg as string[]).join('?'), values: call.slice(1) }
  }
  return { sql: (arg.strings ?? []).join('?'), values: arg.values ?? [] }
}

describe('retrieveHotelCandidates (hybrid RRF)', () => {
  it('fuses vector, trigram and full-text ranks; vector is tenant-materialized (ADR 0073); GIN retrievers filter tenant_id on the table', async () => {
    const { tx, queryRaw } = fakeTx([{ hotelId: 'h1', vectorSimilarity: 0.9, nameSimilarity: 0.8, textRank: 0.1, fusedScore: 0.05 }])
    const rows = await retrieveHotelCandidates(tx, 'tenant_a', { name: 'Atlantis The Palm', city: 'Dubai', countryCode: 'ae' })
    expect(rows).toHaveLength(1)
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const { sql, values } = sqlText(queryRaw.mock.calls[0] as unknown[])
    expect(sql).toContain('vector_ranked')
    expect(sql).toContain('trigram_ranked')
    expect(sql).toContain('text_ranked')
    expect(sql).toContain('"search_tsv" @@')
    expect(sql).toContain('vector_scope AS MATERIALIZED')
    expect(sql).toMatch(/FROM vector_scope\s+ORDER BY "embedding"/)
    expect((sql.match(/"tenant_id" =/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(values).toContain('tenant_a')
    expect(values).toContain('AE')
    expect(values).toContain(60)
  })
})
