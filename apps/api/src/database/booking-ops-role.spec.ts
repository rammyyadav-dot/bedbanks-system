import { BOOKING_OPS_FORBIDDEN_TABLES, BOOKING_OPS_GROUP_ROLE, BOOKING_OPS_LOGIN_ROLE, BOOKING_OPS_READ_TABLES, assertBookingOpsInput, bookingOpsGrantStatements, provisionBookingOpsRole } from './booking-ops-role'
import { apiRuntimeGrantStatements } from './api-runtime-role'

const PASSWORD = 'booking-ops-unit-test-password-0123456789'

describe('booking module database role (ADR 0039)', () => {
  it('BO-01: Phase 1 grants are SELECT on exactly the five booking tables, plus schema usage, and nothing else', () => {
    const statements = bookingOpsGrantStatements()
    expect(statements[0]).toBe(`GRANT USAGE ON SCHEMA public TO "${BOOKING_OPS_GROUP_ROLE}"`)
    expect(statements.slice(1)).toEqual(['Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'SupplierMutation'].map((t) => `GRANT SELECT ON "${t}" TO "${BOOKING_OPS_GROUP_ROLE}"`))
    expect(statements.join(' ')).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|ALL PRIVILEGES|WITH GRANT OPTION|BYPASSRLS/i)
  })

  it('BO-02: no grant reaches ledger, wallet, documents, audit, identity or hotel tables, and the two lists never overlap', () => {
    const text = bookingOpsGrantStatements().join(' ')
    for (const table of BOOKING_OPS_FORBIDDEN_TABLES) expect(text).not.toContain(`"${table}"`)
    for (const table of BOOKING_OPS_READ_TABLES) expect(BOOKING_OPS_FORBIDDEN_TABLES as readonly string[]).not.toContain(table)
  })

  it('BO-03: the API runtime role gets no booking grant from this module or from its own statements', () => {
    expect(apiRuntimeGrantStatements().join(' ')).not.toMatch(/"Booking(Room|Guest|Event)?"/)
  })

  it('BO-04: provisioning revokes first, never creates an elevated role, and is repeatable', async () => {
    const executed: string[] = []
    const db = { $executeRawUnsafe: async (q: string) => { executed.push(q); return 0 }, $queryRawUnsafe: async () => [] as never }
    await provisionBookingOpsRole(db, { password: PASSWORD })
    await provisionBookingOpsRole(db, { password: PASSWORD })
    const first = executed.slice(0, executed.length / 2)
    expect(first).toEqual(executed.slice(executed.length / 2))
    const sql = first.join('\n')
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    expect(sql).not.toMatch(/\bSUPERUSER\b(?<!NOSUPERUSER)/)
    expect(first.findIndex((q) => q.startsWith('REVOKE ALL'))).toBeLessThan(first.findIndex((q) => q.startsWith('GRANT SELECT')))
    expect(sql).toContain(`GRANT "${BOOKING_OPS_GROUP_ROLE}" TO "${BOOKING_OPS_LOGIN_ROLE}"`)
  })

  it('BO-05: unsafe role names and weak or non-URL-safe passwords are refused without echoing the password', () => {
    expect(() => assertBookingOpsInput('postgres', PASSWORD)).toThrow(/dedicated/)
    expect(() => assertBookingOpsInput(BOOKING_OPS_GROUP_ROLE, PASSWORD)).toThrow(/dedicated/)
    expect(() => assertBookingOpsInput('Bad Name', PASSWORD)).toThrow(/Login role/)
    expect(() => assertBookingOpsInput(BOOKING_OPS_LOGIN_ROLE, 'short')).toThrow(/32-128/)
    try { assertBookingOpsInput(BOOKING_OPS_LOGIN_ROLE, 'has space and "quote"') } catch (error) { expect(String(error)).not.toContain('has space') }
  })
})
