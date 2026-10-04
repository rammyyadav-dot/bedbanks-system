import { API_RUNTIME_WRITE_ALLOWLIST, apiRuntimeGrantStatements, assertApiRuntimeInput } from './api-runtime-role'

describe('api runtime role grants', () => {
  const sql = apiRuntimeGrantStatements().join('\n')

  it('accepts a dedicated login role and a URL-safe password', () => {
    expect(assertApiRuntimeInput('fbeds_api_login', 'a'.repeat(32))).toBeUndefined()
  })

  it('rejects owner, group, and other reserved role names', () => {
    for (const role of ['postgres', 'fbeds_api', 'fbeds_hold_expiry', 'fbeds_rls_test', 'Admin']) {
      expect(() => assertApiRuntimeInput(role, 'a'.repeat(32))).toThrow('dedicated API runtime role')
    }
  })

  it('grants search reads and session writes without finance or hotel mutation', () => {
    expect(sql).toContain('GRANT SELECT ON "Hotel"')
    expect(sql).toContain('GRANT SELECT ON "supplier_memberships"')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON "supplier_room_drafts"')
    expect(sql).not.toMatch(/GRANT UPDATE ON "supplier_memberships"/)
    expect(sql).toContain('GRANT SELECT ON "HotelSearchIndex"')
    expect(sql).toContain('GRANT SELECT, INSERT ON "sessions"')
    expect(sql).toContain('GRANT SELECT, INSERT ON "AuditEvent"')
    expect(sql).not.toContain('Wallet')
    expect(sql).not.toContain('LedgerEntry')
    expect(sql).not.toContain('Booking')
    expect(sql).not.toContain('ConnectorCredentialReference')
    expect(sql).not.toContain('BYPASSRLS')
    expect(sql).not.toMatch(/GRANT UPDATE ON "Hotel"/)
    expect(sql).not.toMatch(/GRANT DELETE/)
  })

  it('gives the pool tables read access only: no INSERT, UPDATE or DELETE, and never the supply rate tables', () => {
    expect(sql).toContain('GRANT SELECT ON "InventoryPool"')
    expect(sql).toContain('GRANT SELECT ON "InventoryPoolDay"')
    expect(sql).not.toMatch(/(INSERT|UPDATE|DELETE)[A-Z, ]* ON "InventoryPool/)
    expect(sql).not.toMatch(/(INSERT|UPDATE)[A-Z, ]* ON "(DailyRate|DailyAvailability|RatePlan|Contract)"/)
    expect(sql).not.toContain('SupplierMutation')
    expect(sql).toContain('GRANT SELECT ON "CancellationPolicy"') // search and recheck read it
  })

  it('reads the mandatory commercial controls and writes none of the Admin authoring tables (ADR 0031)', () => {
    for (const table of ['Agency', 'AgencyMember', 'DistributionRestriction', 'CommercialMarkupRule']) expect(sql).toContain(`GRANT SELECT ON "${table}"`)
    for (const table of ['Agency', 'AgencyMember', 'AgencyCreditLimit', 'ApprovalRequest', 'CommercialMarkupRule', 'DistributionRestriction', 'HotelProfile', 'HotelAmenity', 'HotelImage', 'HotelExternalIdentifier', 'RoomAmenity', 'ServiceCase', 'ServiceCaseNote', 'InventoryPool', 'InventoryPoolDay']) {
      expect(sql).not.toMatch(new RegExp(`(INSERT|UPDATE|DELETE)[A-Z, ]* ON "${table}"`))
    }
  })

  it('every write the grant statements give is on the allowlist the verifier enforces, and the allowlist has nothing the grants do not give', () => {
    const granted = new Map<string, Set<string>>()
    for (const statement of apiRuntimeGrantStatements()) {
      const match = /^GRANT (UPDATE \([^)]*\)|[A-Z, ]+) ON "([^"]+)"/.exec(statement)
      if (!match) continue
      for (const privilege of match[1].replace(/\s*\(.*\)/, '').split(',').map((p) => p.trim())) {
        if (privilege === 'SELECT') continue
        granted.set(match[2], new Set([...(granted.get(match[2]) ?? []), privilege]))
      }
    }
    const allowed = new Map(Object.entries(API_RUNTIME_WRITE_ALLOWLIST).map(([table, privileges]) => [table, new Set(privileges)]))
    expect(Object.fromEntries([...granted].map(([t, p]) => [t, [...p].sort()]))).toEqual(Object.fromEntries([...allowed].map(([t, p]) => [t, [...p].sort()])))
  })
})
