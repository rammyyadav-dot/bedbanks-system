import { ServiceUnavailableException } from '@nestjs/common'
import { BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE } from '@bedbanks/contracts'
import { BookingTransactionDatabase } from '../agent/booking-transaction.database'
import {
  BOOKTX_FORBIDDEN_TABLES, BOOKTX_GROUP_ROLE, BOOKTX_PROBES, BOOKTX_UPDATE_COLUMNS,
  assertBooktxInput, booktxGrantStatements, provisionBooktxRole,
} from './booking-transaction-role'

const password = 'a'.repeat(32)

describe('booking transaction role contract (ADR 0113)', () => {
  it('grants no delete, no table-wide update, and no credit, balance or stock-authoring column', () => {
    const sql = booktxGrantStatements().join('\n')
    expect(sql).not.toMatch(/DELETE/i)
    expect(sql).not.toMatch(/GRANT UPDATE ON /)
    expect(sql).not.toMatch(/credit_limit|cached_balance|allotment|capacity/)
    for (const table of BOOKTX_FORBIDDEN_TABLES) expect(sql).not.toContain(`"${table}"`)
    expect(BOOKTX_UPDATE_COLUMNS.DailyAvailability).toEqual(['held', 'sold', 'updated_at'])
    expect(BOOKTX_UPDATE_COLUMNS.Wallet).toEqual(['updated_at'])
    expect(BOOKTX_PROBES.every((probe) => probe.sql.includes('WHERE false'))).toBe(true)
  })

  it('rejects a short password, an unsafe password and the group name as the login', () => {
    expect(() => assertBooktxInput('fbeds_booktx_ops', 'short')).toThrow(/32-128/)
    expect(() => assertBooktxInput('fbeds_booktx_ops', `${password}!`)).toThrow(/URL-safe/)
    expect(() => assertBooktxInput(BOOKTX_GROUP_ROLE, password)).toThrow(/dedicated/)
  })

  it('revokes table, function and column privileges before it grants', async () => {
    const queries: string[] = []
    const db = { $executeRawUnsafe: async (query: string) => { queries.push(query); return 0 }, $queryRawUnsafe: async <T>() => [] as T }
    await provisionBooktxRole(db, { password })
    const revoke = queries.findIndex((query) => query.includes('REVOKE ALL ON ALL TABLES'))
    const columns = queries.findIndex((query) => query.includes('REVOKE ALL (%I)'))
    const grant = queries.findIndex((query) => query.startsWith('GRANT USAGE'))
    expect(revoke).toBeGreaterThanOrEqual(0)
    expect(columns).toBeGreaterThan(revoke)
    expect(grant).toBeGreaterThan(columns)
    expect(queries.some((query) => query.includes('GRANT DELETE') || /GRANT UPDATE ON "/.test(query))).toBe(false)
  })
})

describe('BookingTransactionDatabase', () => {
  it('refuses an unconfigured or reused URL before opening a connection', async () => {
    const closed = new BookingTransactionDatabase({ DATABASE_URL: 'postgresql://fbeds_api_login:secret@127.0.0.1/app' })
    await expect(closed.withTenant('tenant', async () => 'ran')).rejects.toBeInstanceOf(ServiceUnavailableException)
    const reused = new BookingTransactionDatabase({
      DATABASE_URL: 'postgresql://fbeds_api_login:secret@127.0.0.1/app',
      BOOKING_TRANSACTION_DATABASE_URL: 'postgresql://fbeds_api_login:secret@127.0.0.1/app',
    })
    try {
      await reused.withTenant('tenant', async () => 'ran')
      throw new Error('expected refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException)
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE })
    }
  })
})
