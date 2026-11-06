import { BOOKING_EXECUTION_COLUMN_READS, BOOKING_EXECUTION_FORBIDDEN_TABLES, BOOKING_EXECUTION_GROUP_ROLE, BOOKING_EXECUTION_INSERT_TABLES, BOOKING_EXECUTION_LOGIN_ROLE, BOOKING_EXECUTION_READ_TABLES, BOOKING_EXECUTION_UPDATE_COLUMNS, assertBookingExecutionInput, bookingExecutionGrantStatements, provisionBookingExecutionRole } from './booking-execution-role'

const PASSWORD = 'booking-execution-unit-test-password-0123456789'

describe('booking execution database role (ADR 0113)', () => {
  const statements = bookingExecutionGrantStatements()
  const text = statements.join('\n')

  it('grants usage, the joined catalogue, append of the booking transaction, and update of only the columns that transaction changes', () => {
    expect(statements[0]).toBe(`GRANT USAGE ON SCHEMA public TO "${BOOKING_EXECUTION_GROUP_ROLE}"`)
    expect(statements.filter((q) => q.startsWith('GRANT SELECT ON '))).toEqual(BOOKING_EXECUTION_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${BOOKING_EXECUTION_GROUP_ROLE}"`))
    expect(statements.filter((q) => q.startsWith('GRANT SELECT ('))).toEqual(Object.entries(BOOKING_EXECUTION_COLUMN_READS).map(([table, columns]) => `GRANT SELECT (${columns.map((c) => `"${c}"`).join(', ')}) ON "${table}" TO "${BOOKING_EXECUTION_GROUP_ROLE}"`))
    expect(statements.filter((q) => q.startsWith('GRANT INSERT'))).toEqual(BOOKING_EXECUTION_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${BOOKING_EXECUTION_GROUP_ROLE}"`))
    expect(statements.filter((q) => q.startsWith('GRANT UPDATE'))).toEqual(Object.entries(BOOKING_EXECUTION_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${columns.map((c) => `"${c}"`).join(', ')}) ON "${table}" TO "${BOOKING_EXECUTION_GROUP_ROLE}"`))
    expect(text).not.toMatch(/DELETE|TRUNCATE|ALL PRIVILEGES|WITH GRANT OPTION|BYPASSRLS|REFERENCES|TRIGGER/i)
    expect(statements.filter((q) => q.includes('"Wallet"') && q.startsWith('GRANT UPDATE'))).toEqual([`GRANT UPDATE ("updated_at") ON "Wallet" TO "${BOOKING_EXECUTION_GROUP_ROLE}"`])
  })

  it('does not grant identity, credentials, prices, funding, or the finance posting tables', () => {
    for (const table of BOOKING_EXECUTION_FORBIDDEN_TABLES) expect(text).not.toContain(`"${table}"`)
    expect(text).not.toMatch(/"total_minor"|"credit_limit"|"cached_balance"|"allotment"|"capacity"|"contacts"/)
    for (const table of ['DailyRate', 'Hotel', 'RatePlan', 'users', 'sessions']) expect(statements.some((q) => q.startsWith('GRANT INSERT') && q.includes(`"${table}"`))).toBe(false)
    for (const table of [...BOOKING_EXECUTION_READ_TABLES, ...BOOKING_EXECUTION_INSERT_TABLES]) expect(BOOKING_EXECUTION_FORBIDDEN_TABLES as readonly string[]).not.toContain(table)
  })

  it('revokes every table, function and column privilege before it grants, and never creates an elevated role', async () => {
    const executed: string[] = []
    const db = { $executeRawUnsafe: async (q: string) => { executed.push(q); return 0 }, $queryRawUnsafe: async () => [] as never }
    await provisionBookingExecutionRole(db, { password: PASSWORD })
    const sql = executed.join('\n')
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    expect(sql).not.toMatch(/\bSUPERUSER\b(?<!NOSUPERUSER)/)
    expect(executed.findIndex((q) => q.startsWith('REVOKE ALL ON ALL TABLES'))).toBeLessThan(executed.findIndex((q) => q.startsWith('GRANT SELECT')))
    expect(sql).toContain('REVOKE ALL (')
    expect(sql).toContain(`GRANT "${BOOKING_EXECUTION_GROUP_ROLE}" TO "${BOOKING_EXECUTION_LOGIN_ROLE}"`)
    expect(sql).not.toMatch(/GRANT ALL/i)
  })

  it('refuses a shared login and a password that is not URL-safe, without echoing the password', () => {
    expect(() => assertBookingExecutionInput('postgres', PASSWORD)).toThrow(/dedicated/)
    expect(() => assertBookingExecutionInput(BOOKING_EXECUTION_GROUP_ROLE, PASSWORD)).toThrow(/dedicated/)
    expect(() => assertBookingExecutionInput('fbeds_api', PASSWORD)).toThrow(/dedicated/)
    expect(() => assertBookingExecutionInput('fbeds_booking', PASSWORD)).toThrow(/dedicated/)
    expect(() => assertBookingExecutionInput('Bad Name', PASSWORD)).toThrow(/Login role/)
    expect(() => assertBookingExecutionInput(BOOKING_EXECUTION_LOGIN_ROLE, 'short')).toThrow(/32-128/)
    try { assertBookingExecutionInput(BOOKING_EXECUTION_LOGIN_ROLE, 'has space and "quote"') } catch (error) { expect(String(error)).not.toContain('has space') }
  })
})
