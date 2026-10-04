import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('re-applies every grant the committed migrations give the group role, so re-provisioning cannot revoke an Admin feature', () => {
    const dir = join(__dirname, '..', '..', 'prisma', 'migrations')
    const declared = new Set<string>()
    for (const name of readdirSync(dir)) {
      let text: string
      try { text = readFileSync(join(dir, name, 'migration.sql'), 'utf8') } catch { continue }
      for (const m of text.matchAll(/GRANT ([A-Z, ]+?) ON "([A-Za-z_]+)" TO fbeds_api/g)) {
        for (const privilege of m[1].split(',').map((p) => p.trim())) declared.add(`${m[2]}:${privilege}`)
      }
    }
    expect(declared.size).toBeGreaterThan(15)
    const granted = new Set<string>()
    for (const statement of apiRuntimeGrantStatements()) {
      const m = /^GRANT ([A-Z, ]+?) ON "([A-Za-z_]+)" TO/.exec(statement)
      if (m) for (const privilege of m[1].split(',').map((p) => p.trim())) granted.add(`${m[2]}:${privilege}`)
    }
    expect([...declared].filter((entry) => !granted.has(entry))).toEqual([])
  })

  it('keeps the pool tables read-and-write only for rows (no DELETE) and never grants supply-rate tables', () => {
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON "InventoryPool"')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON "InventoryPoolDay"')
    expect(sql).not.toMatch(/DELETE ON "InventoryPool/)
    expect(sql).not.toMatch(/(INSERT|UPDATE)[A-Z, ]* ON "(DailyRate|DailyAvailability|RatePlan|Contract)"/)
  })
})
