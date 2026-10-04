import { apiRuntimeGrantStatements, assertApiRuntimeInput } from './api-runtime-role'

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

  it('reads the mandatory commercial controls (ADR 0031)', () => {
    for (const table of ['Agency', 'AgencyMember', 'DistributionRestriction', 'CommercialMarkupRule']) expect(sql).toContain(`ON "${table}" TO`)
    for (const table of ['Agency', 'AgencyMember', 'DistributionRestriction', 'CommercialMarkupRule']) expect(apiRuntimeGrantStatements().some((s) => s.startsWith('GRANT SELECT') && s.includes(`ON "${table}"`))).toBe(true)
  })

  it('never grants the privileged paths: no supply-authoring, booking, finance or journal write', () => {
    for (const table of ['SupplierMutation', 'RoomAmenity', 'RoomType', 'Contract', 'RatePlan', 'DailyRate', 'DailyAvailability', 'Supplier', 'Booking', 'InventoryHold', 'LedgerEntry', 'Wallet', 'Tenant', 'TenantSettings']) {
      expect(apiRuntimeGrantStatements().filter((s) => new RegExp(`(INSERT|UPDATE|DELETE)[A-Z, ()"_a-z]* ON "${table}"`).test(s))).toEqual([])
    }
    expect(sql).not.toMatch(/GRANT DELETE/)
    expect(sql).not.toMatch(/GRANT [A-Z, ]*(INSERT|UPDATE|DELETE)[A-Z, ]* ON "Hotel"/) // Hotel is column-level UPDATE only
  })
})
