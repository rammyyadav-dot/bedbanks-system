import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaService } from '../src/database/prisma.service'
import { TenantScopeViolation } from '../src/database/tenant-scope-guard'

jest.setTimeout(60_000)

/**
 * ADR 0104: the structural guard on the withTenant client, on a real PostgreSQL connection that BYPASSES RLS (schema owner).
 * Without the guard a forgotten predicate would read and change tenant B's ledger from tenant A's transaction; each attack is
 * paired with a positive control on A's own rows, and B's rows are re-read at the end to prove nothing moved.
 */
describe('tenant scope guard on the ledger (PostgreSQL, RLS bypassed)', () => {
  const owner = new PrismaClient()
  const service = new PrismaService()
  const suffix = `tg-${Date.now()}-${randomBytes(3).toString('hex')}`
  const A = { tenant: '', wallet: '', entry: '' }
  const B = { tenant: '', wallet: '', entry: '' }

  async function seed(label: 'A' | 'B', t: typeof A) {
    t.tenant = (await owner.tenant.create({ data: { name: `${suffix} ${label}`, slug: `${suffix}-${label.toLowerCase()}` } })).id
    t.wallet = (await owner.wallet.create({ data: { tenantId: t.tenant, currency: 'AED' } })).id
    t.entry = (await owner.ledgerEntry.create({ data: { tenantId: t.tenant, walletId: t.wallet, type: 'CREDIT', amountMinor: 1000n, currency: 'AED', idempotencyKey: `${suffix}-${label}` } as never })).id
  }

  beforeAll(async () => { await owner.$connect(); await service.$connect(); await seed('A', A); await seed('B', B) })
  afterAll(async () => { await service.$disconnect(); await owner.$disconnect() })

  it('control: the connection really bypasses RLS', async () => {
    const seen = await service.withTenant(A.tenant, (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "LedgerEntry" WHERE id = ${B.entry}`)
    expect(seen).toHaveLength(1)
  })

  it('a ledger query with no tenant predicate sees only the active tenant', async () => {
    const rows = await service.withTenant(A.tenant, (tx) => tx.ledgerEntry.findMany({ where: { id: { in: [A.entry, B.entry] } } }))
    expect(rows.map((r) => r.id)).toEqual([A.entry])
    expect(await service.withTenant(A.tenant, (tx) => tx.ledgerEntry.findUnique({ where: { id: B.entry } }))).toBeNull()
    expect(await service.withTenant(A.tenant, (tx) => tx.wallet.count())).toBe(1)
  })

  it('writes by tenant B ids change nothing; naming B throws', async () => {
    const res = await service.withTenant(A.tenant, (tx) => tx.wallet.updateMany({ where: { id: B.wallet }, data: { currency: 'USD' } }))
    expect(res.count).toBe(0)
    await expect(service.withTenant(A.tenant, async (tx) => tx.ledgerEntry.findMany({ where: { tenantId: B.tenant } }))).rejects.toThrow(TenantScopeViolation)
    await expect(service.withTenant(A.tenant, async (tx) => tx.ledgerEntry.create({ data: { tenantId: B.tenant, walletId: B.wallet, type: 'CREDIT', amountMinor: 1n, currency: 'AED', idempotencyKey: `${suffix}-x` } as never }))).rejects.toThrow(TenantScopeViolation)
  })

  it('create without a tenant is stamped with the active tenant; positive control on A', async () => {
    const created = await service.withTenant(A.tenant, (tx) => tx.wallet.create({ data: { currency: 'USD' } as never }))
    expect(created.tenantId).toBe(A.tenant)
    expect(await service.withTenant(A.tenant, (tx) => tx.wallet.update({ where: { id: A.wallet }, data: { currency: 'AED' } }))).toMatchObject({ id: A.wallet })
  })

  it('tenant B is untouched', async () => {
    expect(await owner.wallet.findUnique({ where: { id: B.wallet } })).toMatchObject({ currency: 'AED' })
    expect(await owner.ledgerEntry.count({ where: { tenantId: B.tenant } })).toBe(1)
  })
})
