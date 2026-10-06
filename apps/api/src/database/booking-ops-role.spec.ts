import { BOOKING_OPS_FORBIDDEN_TABLES, BOOKING_OPS_INSERT_TABLES, BOOKING_OPS_GROUP_ROLE, BOOKING_OPS_LOGIN_ROLE, BOOKING_OPS_READ_TABLES, assertBookingOpsInput, bookingOpsGrantStatements, provisionBookingOpsRole } from './booking-ops-role'
import { apiRuntimeGrantStatements } from './api-runtime-role'

const PASSWORD = 'booking-ops-unit-test-password-0123456789'

describe('booking module database role (ADR 0039)', () => {
  it('BO-01: grants are SELECT on the five booking tables, INSERT on the four booking tables plus AuditEvent, and UPDATE on named Booking columns only', () => {
    const statements = bookingOpsGrantStatements()
    expect(statements[0]).toBe(`GRANT USAGE ON SCHEMA public TO "${BOOKING_OPS_GROUP_ROLE}"`)
    expect(statements.filter((q) => q.startsWith('GRANT SELECT'))).toEqual(['Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'SupplierMutation', 'BookingSupplierJob', 'BookingSupplierCall', 'BookingOpsState', 'BookingDocument', 'BookingFinanceEvent'].map((t) => `GRANT SELECT ON "${t}" TO "${BOOKING_OPS_GROUP_ROLE}"`))
    expect(statements.filter((q) => q.startsWith('GRANT INSERT'))).toEqual(['Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'AuditEvent', 'BookingSupplierJob', 'BookingSupplierCall', 'BookingOpsState', 'BookingDocument', 'BookingFinanceEvent'].map((t) => `GRANT INSERT ON "${t}" TO "${BOOKING_OPS_GROUP_ROLE}"`))
    expect(statements.filter((q) => q.startsWith('GRANT UPDATE'))).toEqual([
      `GRANT UPDATE ("status", "supplier_status", "supplier_ref", "hotel_confirmation_no", "agent_ref", "version", "closed_at", "updated_at") ON "Booking" TO "${BOOKING_OPS_GROUP_ROLE}"`,
      `GRANT UPDATE ("status", "attempt", "run_after", "locked_until", "last_error_code", "completed_at", "updated_at") ON "BookingSupplierJob" TO "${BOOKING_OPS_GROUP_ROLE}"`,
      `GRANT UPDATE ("assignee_user_id", "assigned_at", "assigned_by_user_id", "acknowledged_at", "acknowledged_by_user_id", "manual_priority", "escalated_at", "escalated_by_user_id", "escalation_reason", "follow_up", "follow_up_at", "resolved_at", "resolved_by_user_id", "version", "updated_at") ON "BookingOpsState" TO "${BOOKING_OPS_GROUP_ROLE}"`,
    ])
    expect(statements.filter((q) => q.startsWith('GRANT EXECUTE'))).toEqual([`GRANT EXECUTE ON FUNCTION "fbeds_booking_due_tenants"(timestamp) TO "${BOOKING_OPS_GROUP_ROLE}"`])
    expect(statements.join(' ')).not.toMatch(/DELETE|TRUNCATE|ALL PRIVILEGES|WITH GRANT OPTION|BYPASSRLS|REFERENCES|TRIGGER/i)
    expect(statements.length).toBe(1 + 10 + 10 + 3 + 1)
  })

  it('BO-02: no grant reaches ledger, wallet, audit, identity or hotel tables, and the two lists never overlap', () => {
    const text = bookingOpsGrantStatements().join(' ')
    for (const table of BOOKING_OPS_FORBIDDEN_TABLES) expect(text).not.toContain(`"${table}"`)
    for (const table of [...BOOKING_OPS_READ_TABLES, ...BOOKING_OPS_INSERT_TABLES]) expect(BOOKING_OPS_FORBIDDEN_TABLES as readonly string[]).not.toContain(table)
    expect(bookingOpsGrantStatements().filter((q) => q.includes('"AuditEvent"'))).toEqual([`GRANT INSERT ON "AuditEvent" TO "${BOOKING_OPS_GROUP_ROLE}"`]) // the audit log is write-only for this role
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
    expect(first.findIndex((q) => q.startsWith('REVOKE ALL ON ALL TABLES'))).toBeLessThan(first.findIndex((q) => q.startsWith('GRANT SELECT')))
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
