import { eraseLedger } from './ledger-erasure'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ConflictException } from '@nestjs/common'
import { PrismaClient, type Prisma } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { assertRuntimeDbIdentity } from '../src/database/runtime-db-identity'
import { LedgerService } from '../src/agent/ledger.service'
import { BookingFinancialAuthorizationService } from '../src/agent/booking-financial-authorization.service'
import { assertAgencyCredit } from '../src/agent/agency-credit'
import { lockAgencyCredit } from '../src/agent/agency-account'
import { AgentAuditService } from '../src/agent/audit.service'
import { ApprovalService } from '../src/approvals/approval.service'
import { ClientsService } from '../src/departments/clients.service'
import { AgencySuspensionService } from '../src/departments/agency-suspension.service'
import { AgencyCreditService, CREDIT_ENTITY_TYPE, CREDIT_LIMIT_APPROVAL_ACTION } from '../src/departments/agency-credit.service'

jest.setTimeout(30_000)

/** Real PostgreSQL locks and forced RLS; no mocked transaction, query or financial service.
 * DATABASE_URL must be an owner connection to a DISPOSABLE migrated database.
 * The unique test login has explicit financial grants; this does not certify production runtime grants.
 */
const describeDisposable = process.env.ALLOW_DISPOSABLE_CREDIT_TESTS === 'true' ? describe : describe.skip

describeDisposable('PostgreSQL credit concurrency and financial RLS', () => {
  const suffix = randomBytes(8).toString('hex')
  const role = `credit_probe_${suffix}`
  const ownerUrl = process.env.DATABASE_URL
  // Explicit opt-in prevents accidentally provisioning a test login in a persistent database.
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  let db: PrismaService
  let single: PrismaService
  let finance: BookingFinancialAuthorizationService
  let credit: AgencyCreditService
  let approvals: ApprovalService
  let tenantA = '', tenantB = '', maker = '', checker = ''
  let seq = 0
  const next = () => `${suffix}-${++seq}`
  type Account = { tenantId: string; agencyId: string; walletId: string }
  let a: Account, b: Account

  async function account(tenantId: string, limitMinor: bigint | null = 10000n): Promise<Account> {
    const agency = await owner.agency.create({ data: { tenantId, code: next().toUpperCase(), name: 'Credit integration fixture', createdById: maker } })
    const wallet = await owner.wallet.create({ data: { tenantId, agencyId: agency.id, currency: 'AED' } })
    if (limitMinor !== null) await owner.agencyCreditLimit.create({ data: { tenantId, agencyId: agency.id, currency: 'AED', limitMinor, updatedById: maker } })
    return { tenantId, agencyId: agency.id, walletId: wallet.id }
  }
  function command(ac: Account, idempotencyKey = next()) {
    return { tenantId: ac.tenantId, walletId: ac.walletId, userId: maker, bookingId: next(), requestId: next(), currency: 'AED', amountMinor: 6000n, idempotencyKey }
  }
  async function approved(ac: Account, before: bigint | null, after: bigint | null) {
    const request = await approvals.request({ tenantId: ac.tenantId, requesterId: maker, action: CREDIT_LIMIT_APPROVAL_ACTION,
      entityType: CREDIT_ENTITY_TYPE, entityId: ac.agencyId, requestId: next(), reason: 'Integration test',
      beforeState: { currency: before === null ? null : 'AED', limitMinor: before?.toString() ?? null },
      proposedState: { currency: after === null ? null : 'AED', limitMinor: after?.toString() ?? null } })
    await approvals.decide({ tenantId: ac.tenantId, approverId: checker, approvalId: request.id, decision: 'APPROVED', reason: 'Checked integration fixture' })
    return request.id
  }

  // Observe PostgreSQL's wait graph rather than assume a request is blocked after a fixed sleep.
  async function blocked() {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const rows = await owner.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename = ${role}
          AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting`
      if (rows[0]?.waiting) return
      await delay(20)
    }
    throw new Error('Expected a PostgreSQL lock wait from the restricted test login')
  }

  /** Hold the agency lock, start a REAL service operation, prove PostgreSQL blocks it, then commit/rollback. */
  async function whileLocked<T>(ac: Account, start: () => Promise<T>, mutate?: (tx: Prisma.TransactionClient) => Promise<unknown>, rollback = false, finish?: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let release!: () => void, acquired!: () => void
    const ready = new Promise<void>(resolve => { acquired = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const sentinel = new Error('intentional blocker rollback')
    const holder = db.withTenant(ac.tenantId, async tx => {
      await lockAgencyCredit(tx, ac.agencyId)
      if (mutate) await mutate(tx)
      acquired()
      await gate
      if (finish) await finish(tx)
      if (rollback) throw sentinel
    }).catch(error => { if (error !== sentinel) throw error })
    // Race setup errors against acquisition, avoiding a hanging barrier if a DB query fails.
    await Promise.race([ready, holder.then(() => { throw new Error('Lock holder ended before acquisition') })])
    const result = start().then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    try { await blocked() } finally { release(); await holder }
    return result
  }

  beforeAll(async () => {
    if (!ownerUrl) throw new Error('DATABASE_URL is required')
    await owner.$connect()
    const password = randomBytes(24).toString('hex')
    // Both interpolated tokens are generated hex / identifier-safe values, never user input.
    await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "Wallet", "LedgerEntry", "AgencyCreditLimit", "Agency", "AgencyMember", "ApprovalRequest", "AuditEvent" TO "${role}"`)
    await owner.$executeRawUnsafe(`GRANT SELECT ON users, memberships, "InventoryHold" TO "${role}"`)
    const url = new URL(ownerUrl!); url.username = role; url.password = password; url.searchParams.set('connection_limit', '8')
    const options = { datasourceUrl: url.toString(), transactionOptions: { maxWait: 10000, timeout: 15000 } }
    db = new PrismaService(options)
    url.searchParams.set('connection_limit', '1')
    single = new PrismaService({ ...options, datasourceUrl: url.toString() })
    await db.$connect(); await single.$connect()
    await assertRuntimeDbIdentity(db, 'credit integration')
    finance = new BookingFinancialAuthorizationService(db)
    const audit = new AgentAuditService(db)
    approvals = new ApprovalService(db, audit)
    credit = new AgencyCreditService(db, audit, approvals, new AgencySuspensionService(db, audit, approvals, new ClientsService(db, audit)))
    tenantA = (await owner.tenant.create({ data: { slug: `credit-a-${suffix}`, name: 'Credit A' } })).id
    tenantB = (await owner.tenant.create({ data: { slug: `credit-b-${suffix}`, name: 'Credit B' } })).id
    maker = (await owner.user.create({ data: { email: `maker-${suffix}@example.test` } })).id
    checker = (await owner.user.create({ data: { email: `checker-${suffix}@example.test` } })).id
    for (const tenantId of [tenantA, tenantB]) for (const userId of [maker, checker]) {
      await owner.membership.create({ data: { tenantId, userId, role: 'owner' } })
    }
    a = await account(tenantA); b = await account(tenantB)
    for (const ac of [a, b]) await owner.ledgerEntry.create({ data: { tenantId: ac.tenantId, walletId: ac.walletId, type: 'CREDIT', amountMinor: 100n, currency: 'AED', idempotencyKey: next() } })
  })

  afterAll(async () => {
    await Promise.all([db?.$disconnect(), single?.$disconnect()])
    const tenants = [tenantA, tenantB].filter(Boolean)
    if (tenants.length) {
      await owner.auditEvent.deleteMany({ where: { tenantId: { in: tenants } } })
      await owner.approvalRequest.deleteMany({ where: { tenantId: { in: tenants } } })
      await eraseLedger(owner, { where: { tenantId: { in: tenants } } })
      await owner.wallet.deleteMany({ where: { tenantId: { in: tenants } } })
      await owner.agency.deleteMany({ where: { tenantId: { in: tenants } } })
      await owner.membership.deleteMany({ where: { tenantId: { in: tenants } } })
      await owner.tenant.deleteMany({ where: { id: { in: tenants } } })
    }
    await owner.user.deleteMany({ where: { id: { in: [maker, checker].filter(Boolean) } } })
    await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`)
    await owner.$executeRawUnsafe(`DROP ROLE "${role}"`)
    await owner.$disconnect()
  })

  it('connects as a restricted login and requires forced RLS on all financial tables', async () => {
    const identity = await assertRuntimeDbIdentity(db, 'credit integration')
    expect(identity.currentUser).toBe(role)
    const tables = await owner.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('"Wallet"'::regclass, '"LedgerEntry"'::regclass, '"AgencyCreditLimit"'::regclass)`
    expect(tables).toHaveLength(3)
    expect(tables.every(t => t.relrowsecurity && t.relforcerowsecurity)).toBe(true)
  })

  it('isolates unfiltered wallet, credit-limit and ledger reads in both directions', async () => {
    for (const ac of [a, b]) await db.withTenant(ac.tenantId, async tx => {
      for (const rows of [await tx.wallet.findMany(), await tx.agencyCreditLimit.findMany(), await tx.ledgerEntry.findMany()]) {
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every(row => row.tenantId === ac.tenantId)).toBe(true)
      }
    })
    expect(await db.wallet.findMany()).toEqual([])
    expect(await db.agencyCreditLimit.findMany()).toEqual([])
    expect(await db.ledgerEntry.findMany()).toEqual([])
  })

  it('rejects foreign/no-context inserts with SQLSTATE 42501 and hides foreign update/delete targets', async () => {
    for (const [context, target] of [[a, b], [b, a]]) {
      await expect(db.withTenant(context.tenantId, tx => tx.$executeRaw`
        INSERT INTO "Wallet" (id, tenant_id, currency, updated_at) VALUES (${next()}, ${target.tenantId}, 'USD', now())`
      )).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } })
      await db.withTenant(context.tenantId, async tx => {
        expect(await tx.wallet.updateMany({ where: { id: target.walletId }, data: { cachedBalance: 99n } })).toEqual({ count: 0 })
        expect(await tx.agencyCreditLimit.deleteMany({ where: { agencyId: target.agencyId } })).toEqual({ count: 0 })
      })
    }
    await expect(db.$executeRaw`INSERT INTO "Wallet" (id, tenant_id, currency, updated_at) VALUES (${next()}, ${a.tenantId}, 'USD', now())`)
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } })
    expect((await owner.wallet.findUniqueOrThrow({ where: { id: b.walletId } })).cachedBalance).toBe(0n)
  })

  it('clears tenant context after commit and rollback on the same pooled connection', async () => {
    const pid = async () => (await single.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid
    const initial = await pid()
    for (const ac of [a, b]) {
      await single.withTenant(ac.tenantId, async tx => {
        expect((await tx.wallet.findMany()).every(w => w.tenantId === ac.tenantId)).toBe(true)
        expect((await tx.wallet.findMany()).length).toBeGreaterThan(0)
      })
      expect(await pid()).toBe(initial)
      expect(await single.wallet.findMany()).toEqual([])
      await expect(single.withTenant(ac.tenantId, async tx => {
        await tx.wallet.update({ where: { id: ac.walletId }, data: { cachedBalance: 123n } })
        throw new Error('rollback context test')
      })).rejects.toThrow('rollback context test')
      expect(await pid()).toBe(initial)
      expect(await single.wallet.findMany()).toEqual([])
      expect((await owner.wallet.findUniqueOrThrow({ where: { id: ac.walletId } })).cachedBalance).toBe(0n)
    }
  })

  it.each(['agency', 'house'])('allows only one of 20 simultaneous final-credit authorizations (%s account)', async kind => {
    const wallet = kind === 'house' ? await owner.wallet.create({ data: { tenantId: tenantA, currency: 'AED', creditLimit: 10000n } }) : null
    const ac = wallet ? { tenantId: tenantA, agencyId: '', walletId: wallet.id } : await account(tenantA)
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => finance.authorize(command(ac))))
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(19)
    expect(rejected.every(r => r.reason instanceof ConflictException)).toBe(true)
    const entries = await owner.ledgerEntry.findMany({ where: { walletId: ac.walletId } })
    expect(entries).toHaveLength(1)
    expect(entries[0].amountMinor).toBe(-6000n)
    expect(await owner.auditEvent.count({ where: { tenantId: ac.tenantId, action: 'booking.finance.authorized', entityId: entries[0].reference!.slice('booking:'.length) } })).toBe(1)
  })

  it('converges concurrent retries on one reservation and one audit event', async () => {
    const ac = await account(tenantA)
    const input = command(ac)
    const entries = await Promise.all(Array.from({ length: 20 }, () => finance.authorize(input)))
    expect(new Set(entries.map(e => e.id)).size).toBe(1)
    expect(await owner.ledgerEntry.count({ where: { walletId: ac.walletId } })).toBe(1)
    expect(await owner.auditEvent.count({ where: { action: 'booking.finance.authorized', entityId: input.bookingId } })).toBe(1)
  })

  it('waits for a committed credit reduction before authorizing and refuses overspending', async () => {
    const ac = await account(tenantA)
    const outcome = await whileLocked(ac, () => finance.authorize(command(ac)), tx => tx.agencyCreditLimit.update({ where: { agencyId: ac.agencyId }, data: { limitMinor: 5000n } }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(ConflictException)
    expect(await owner.ledgerEntry.count({ where: { walletId: ac.walletId } })).toBe(0)
  })

  it('direct debits wait for a credit reduction before checking available funds', async () => {
    const ac = await account(tenantA)
    const ledger = new LedgerService(db)
    const outcome = await whileLocked(ac, () => ledger.post({ tenantId: tenantA, walletId: ac.walletId, currency: 'AED', type: 'DEBIT', amountMinor: -6000n, idempotencyKey: next() }),
      tx => tx.agencyCreditLimit.update({ where: { agencyId: ac.agencyId }, data: { limitMinor: 5000n } }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(ConflictException)
    expect(await owner.ledgerEntry.count({ where: { walletId: ac.walletId } })).toBe(0)
  })

  it('takes agency before wallet locks so an in-flight hold can finish without deadlocking authorization', async () => {
    const ac = await account(tenantA)
    const outcome = await whileLocked(ac, () => finance.authorize(command(ac)), undefined, false,
      tx => tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${ac.walletId} AND tenant_id = ${tenantA} FOR UPDATE`)
    expect(outcome.ok).toBe(true)
  })

  it('hold-time credit checking waits for a reduction and refuses the new hold', async () => {
    const ac = await account(tenantA)
    await owner.agencyMember.create({ data: { tenantId: tenantA, agencyId: ac.agencyId, userId: maker } })
    const outcome = await whileLocked(ac,
      () => db.withTenant(tenantA, tx => assertAgencyCredit(tx, tenantA, maker, 'AED', 6000n)),
      tx => tx.agencyCreditLimit.update({ where: { agencyId: ac.agencyId }, data: { limitMinor: 5000n } }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.getResponse()).toMatchObject({ code: 'AGENCY_CREDIT_LIMIT_EXCEEDED', details: { availableMinor: '5000' } })
  })

  it('releases the agency lock on rollback and uses the unchanged credit line', async () => {
    const ac = await account(tenantA)
    const outcome = await whileLocked(ac, () => finance.authorize(command(ac)), tx => tx.agencyCreditLimit.update({ where: { agencyId: ac.agencyId }, data: { limitMinor: 0n } }), true)
    expect(outcome.ok).toBe(true)
    expect((await owner.agencyCreditLimit.findUniqueOrThrow({ where: { agencyId: ac.agencyId } })).limitMinor).toBe(10000n)
  })

  it.each([null, 10000n])('approved limit creation/change waits for an in-flight agency lock (before=%s)', async before => {
    const ac = await account(tenantA, before)
    const approvalId = await approved(ac, before, 5000n)
    const outcome = await whileLocked(ac, () => credit.execute(tenantA, maker, approvalId))
    expect(outcome.ok).toBe(true)
    expect((await owner.agencyCreditLimit.findUniqueOrThrow({ where: { agencyId: ac.agencyId } })).limitMinor).toBe(5000n)
    expect((await owner.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('EXECUTED')
  })

  it('approved limit removal also waits for the agency lock', async () => {
    const ac = await account(tenantA)
    const approvalId = await approved(ac, 10000n, null)
    expect((await whileLocked(ac, () => credit.execute(tenantA, maker, approvalId))).ok).toBe(true)
    expect(await owner.agencyCreditLimit.count({ where: { agencyId: ac.agencyId } })).toBe(0)
    await expect(finance.authorize(command(ac))).rejects.toBeInstanceOf(ConflictException)
  })
})
