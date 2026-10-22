import { PROMOTE_FORBIDDEN_TABLES, PROMOTE_OWN_TABLES, PROMOTE_PROBES, PROMOTE_UPDATE_COLUMNS, assertPromoteInput, promoteGrantStatements, provisionPromoteRole } from './supplier-promotion-role'

describe('supplier promotion role (ADR 0084)', () => {
  it('grants column-level UPDATE only, no DELETE, and nothing on contracts, plans, mappings, finance or identity', () => {
    const grants = promoteGrantStatements().join('\n')
    expect(grants).not.toMatch(/GRANT [A-Z, ]*(DELETE|TRUNCATE|REFERENCES|TRIGGER)/)
    expect(grants).not.toMatch(/GRANT [A-Z, ]*UPDATE[A-Z, ]* ON "/)
    expect(grants).not.toMatch(/UPDATE \([^)]*\) ON "SupplierPromotionRun"/)
    for (const table of PROMOTE_FORBIDDEN_TABLES.filter((t) => t !== 'AuditEvent')) expect(grants).not.toContain(`ON "${table}"`)
    expect(grants).toContain('GRANT INSERT ON "AuditEvent"')
    expect(grants).not.toMatch(/SELECT[^\n]* ON "AuditEvent"/)
    // Observations are read-only; the rate plan, mapping, pool, hotel and ingest run reads are named columns.
    expect(grants).toMatch(/GRANT SELECT ON "SupplierRateObservation"/)
    expect(grants).not.toMatch(/GRANT [A-Z, ]*INSERT[A-Z, ]* ON "Supplier(Rate|Allotment)Observation"/)
    expect(grants).not.toMatch(/GRANT SELECT ON "(RatePlan|Hotel|InventoryPool|SupplierIngestRun|SupplierHotelMapping)"/)
  })

  it('never lets the role update restrictions, sold, held or any identity column', () => {
    const all = Object.entries(PROMOTE_UPDATE_COLUMNS)
    for (const [, columns] of all) for (const forbidden of ['id', 'tenant_id', 'rate_plan_id', 'pool_id', 'stay_date', 'occupancy', 'sold', 'held', 'min_stay', 'closed_to_arrival', 'closed_to_departure', 'created_at']) expect(columns).not.toContain(forbidden)
    expect(PROMOTE_UPDATE_COLUMNS.DailyAvailability).toEqual(expect.arrayContaining(['allotment', 'stop_sell', 'inventory_mode', 'fresh_until']))
  })

  it('probes every own table for allowed read/append and denied delete, and the lanes it must not enter', () => {
    for (const table of PROMOTE_OWN_TABLES) {
      expect(PROMOTE_PROBES).toContainEqual(expect.objectContaining({ name: `INSERT ${table}`, expect: 'allowed' }))
      expect(PROMOTE_PROBES).toContainEqual(expect.objectContaining({ name: `DELETE ${table}`, expect: 'denied' }))
    }
    for (const name of ['UPDATE DailyAvailability.sold', 'UPDATE DailyAvailability.min_stay', 'UPDATE InventoryPoolDay.held', 'UPDATE RatePlan', 'INSERT RatePlan', 'SELECT Contract']) expect(PROMOTE_PROBES).toContainEqual(expect.objectContaining({ name, expect: 'denied' }))
    expect(PROMOTE_PROBES.every((p) => /WHERE false/.test(p.sql))).toBe(true)
  })

  it('validates login names and passwords, and provisioning revokes before it grants and never makes a privileged role', async () => {
    expect(() => assertPromoteInput('fbeds_promote', 'a'.repeat(32))).toThrow(/dedicated/)
    expect(() => assertPromoteInput('postgres', 'a'.repeat(32))).toThrow(/dedicated/)
    expect(() => assertPromoteInput('fbeds_promote_ops', 'short')).toThrow(/Password/)
    const statements: string[] = []
    await provisionPromoteRole({ $executeRawUnsafe: async (q: string) => { statements.push(q); return 0 }, $queryRawUnsafe: async () => [] as never }, { password: 'a'.repeat(40) })
    const revoke = statements.findIndex((s) => s.startsWith('REVOKE ALL ON ALL TABLES'))
    const firstGrant = statements.findIndex((s) => s.startsWith('GRANT SELECT'))
    expect(revoke).toBeGreaterThan(-1)
    expect(revoke).toBeLessThan(firstGrant)
    expect(statements.join('\n')).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
  })
})
