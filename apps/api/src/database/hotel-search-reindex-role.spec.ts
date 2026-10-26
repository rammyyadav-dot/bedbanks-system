import {
  SEARCH_REINDEX_GROUP_ROLE,
  SEARCH_REINDEX_PROBES,
  SEARCH_REINDEX_READ_COLUMNS,
  SEARCH_REINDEX_UPDATE_COLUMNS,
  assertSearchReindexInput,
  provisionSearchReindexRole,
  searchReindexGrantStatements,
} from './hotel-search-reindex-role'

describe('hotel search reindex role', () => {
  const password = 'Ab1_-'.repeat(8)

  it('accepts a dedicated login and a strong password', () => {
    expect(() => assertSearchReindexInput('fbeds_search_reindex_ops', password)).not.toThrow()
  })

  it('rejects the group role, postgres, a bad name and a weak password without echoing the password', () => {
    expect(() => assertSearchReindexInput(SEARCH_REINDEX_GROUP_ROLE, password)).toThrow(/dedicated/)
    expect(() => assertSearchReindexInput('postgres', password)).toThrow(/dedicated/)
    expect(() => assertSearchReindexInput('Bad Role', password)).toThrow(/Login role/)
    expect(() => assertSearchReindexInput('fbeds_search_reindex_ops', 'weak-secret!')).toThrow(/Password must/)
    try { assertSearchReindexInput('fbeds_search_reindex_ops', 'weak-secret!') } catch (error) { expect(String(error)).not.toContain('weak-secret') }
  })

  it('grants no DELETE, TRUNCATE, table-wide UPDATE or write on Hotel', () => {
    const grants = searchReindexGrantStatements().join('\n')
    expect(grants).not.toMatch(/DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL PRIVILEGES/)
    expect(grants).toMatch(/GRANT SELECT, INSERT ON "HotelSearchIndex"/)
    expect(grants).not.toMatch(/GRANT (SELECT, )?(INSERT|UPDATE) ON "(Hotel|tenants)"/)
    expect(searchReindexGrantStatements().filter((s) => s.startsWith('GRANT UPDATE ('))).toHaveLength(1)
  })

  it('never lets the role change the tenant or hotel identity of an index row', () => {
    expect(SEARCH_REINDEX_UPDATE_COLUMNS).not.toContain('tenant_id')
    expect(SEARCH_REINDEX_UPDATE_COLUMNS).not.toContain('hotel_id')
    expect(SEARCH_REINDEX_UPDATE_COLUMNS).not.toContain('id')
  })

  it('reads tenant_id (for row-level security) and only the identity columns of Hotel', () => {
    expect(SEARCH_REINDEX_READ_COLUMNS.Hotel).toContain('tenant_id')
    expect(SEARCH_REINDEX_READ_COLUMNS.tenants).toEqual(['id'])
  })

  it('probes both allowed and denied behaviour with statements that touch no row', () => {
    expect(SEARCH_REINDEX_PROBES.some((p) => p.expect === 'allowed')).toBe(true)
    expect(SEARCH_REINDEX_PROBES.some((p) => p.expect === 'denied')).toBe(true)
    for (const probe of SEARCH_REINDEX_PROBES) expect(probe.sql).toMatch(/WHERE false|SELECT 'x' WHERE false/)
  })

  it('provisions with a safe attribute set, a connection limit, and revokes before granting', async () => {
    const statements: string[] = []
    await provisionSearchReindexRole({ $executeRawUnsafe: async (q) => { statements.push(q); return 0 }, $queryRawUnsafe: async () => [] as never }, { password })
    const all = statements.join('\n')
    expect(all).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    expect(all).toContain('CONNECTION LIMIT 2')
    const revoke = statements.findIndex((s) => s.startsWith('REVOKE ALL ON ALL TABLES'))
    const grant = statements.findIndex((s) => s.startsWith('GRANT SELECT, INSERT ON "HotelSearchIndex"'))
    expect(revoke).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(revoke)
  })
})
