import { INGEST_FORBIDDEN_TABLES, INGEST_OWN_TABLES, INGEST_PROBES, INGEST_UPDATE_COLUMNS, assertIngestInput, ingestGrantStatements, provisionIngestRole } from './supplier-ingest-role'

describe('supplier ingestion role (ADR 0079)', () => {
  it('grants no table-wide UPDATE or DELETE, no run update, and nothing on contracted inventory, finance or identity', () => {
    const grants = ingestGrantStatements().join('\n')
    expect(grants).not.toMatch(/GRANT [A-Z, ]*(DELETE|TRUNCATE|REFERENCES|TRIGGER)/)
    expect(grants).not.toMatch(/GRANT [A-Z, ]*UPDATE[A-Z, ]* ON "/) // UPDATE is column-level only
    expect(grants).not.toMatch(/UPDATE \([^)]*\) ON "SupplierIngestRun"/)
    for (const table of INGEST_FORBIDDEN_TABLES.filter((t) => t !== 'AuditEvent')) expect(grants).not.toContain(`ON "${table}"`)
    expect(grants).toContain('GRANT INSERT ON "AuditEvent"')
    expect(grants).not.toMatch(/SELECT[^\n]* ON "AuditEvent"/)
  })

  it('never lets the role update an observation\'s identity columns', () => {
    for (const columns of Object.values(INGEST_UPDATE_COLUMNS)) {
      for (const identity of ['id', 'tenant_id', 'supplier_id', 'supplier_hotel_code', 'supplier_room_code', 'supplier_rate_plan_code', 'stay_date', 'created_at']) expect(columns).not.toContain(identity)
    }
  })

  it('probes every own table for allowed read/append and denied delete, and every forbidden table for denied reads', () => {
    for (const table of INGEST_OWN_TABLES) {
      expect(INGEST_PROBES).toContainEqual(expect.objectContaining({ name: `INSERT ${table}`, expect: 'allowed' }))
      expect(INGEST_PROBES).toContainEqual(expect.objectContaining({ name: `DELETE ${table}`, expect: 'denied' }))
    }
    expect(INGEST_PROBES.every((p) => /WHERE false/.test(p.sql))).toBe(true)
  })

  it('validates login names and passwords, and provisioning revokes before it grants and never makes a privileged role', async () => {
    expect(() => assertIngestInput('fbeds_ingest', 'a'.repeat(32))).toThrow(/dedicated/)
    expect(() => assertIngestInput('postgres', 'a'.repeat(32))).toThrow(/dedicated/)
    expect(() => assertIngestInput('fbeds_ingest_ops', 'short')).toThrow(/Password/)
    const statements: string[] = []
    await provisionIngestRole({ $executeRawUnsafe: async (q: string) => { statements.push(q); return 0 }, $queryRawUnsafe: async () => [] as never }, { password: 'a'.repeat(40) })
    const revoke = statements.findIndex((s) => s.startsWith('REVOKE ALL ON ALL TABLES'))
    const firstGrant = statements.findIndex((s) => s.startsWith('GRANT SELECT'))
    expect(revoke).toBeGreaterThan(-1)
    expect(revoke).toBeLessThan(firstGrant)
    expect(statements.join('\n')).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
  })
})
