import { BadRequestException, NotFoundException } from '@nestjs/common'
import { OperationsTransactionsService } from './operations-transactions.service'

type Wallet = { id: string; tenantId: string; agencyId: string | null; currency: string; creditLimit: bigint; updatedAt: Date; agency?: { id: string; code: string; name: string } | null }

function setup(opts: { agency?: { id: string; code: string; name: string; status: string } | null; accounts?: Wallet[]; sums?: Array<{ walletId: string; _sum: { amountMinor: bigint | null }; _count: { _all: number }; _max?: { immutableAt: Date | null } }>; entries?: Record<string, unknown[]> }) {
  const tx = {
    agency: { findFirst: jest.fn().mockResolvedValue(opts.agency === undefined ? { id: 'ag1', code: 'GULF', name: 'Gulf Travel', status: 'ACTIVE' } : opts.agency) },
    wallet: { findMany: jest.fn().mockResolvedValue(opts.accounts ?? []), count: jest.fn().mockResolvedValue((opts.accounts ?? []).length) },
    ledgerEntry: {
      groupBy: jest.fn().mockResolvedValue(opts.sums ?? []),
      findMany: jest.fn(({ where }: { where: { walletId: string } }) => Promise.resolve(opts.entries?.[where.walletId] ?? [])),
    },
  }
  const prisma = { withTenant: jest.fn((_t: string, work: (t: unknown) => unknown) => work(tx)) }
  return { service: new OperationsTransactionsService(prisma as never, {} as never), tx }
}

const at = new Date('2026-10-04T08:00:00.000Z')
const entry = (id: string, walletId: string, amountMinor: bigint) => ({ id, walletId, type: 'CREDIT', amountMinor, currency: 'AED', reference: null, idempotencyKey: `k-${id}`, immutableAt: at })

describe('OperationsTransactionsService.agencyAccount (ADR 0028 slice 1)', () => {
  const saved = process.env.SETTLEMENT_CURRENCIES
  afterEach(() => { if (saved === undefined) delete process.env.SETTLEMENT_CURRENCIES; else process.env.SETTLEMENT_CURRENCIES = saved })

  it('reports a not-opened AED account with an exact zero balance when the agency has no account', async () => {
    delete process.env.SETTLEMENT_CURRENCIES
    const { service, tx } = setup({})
    const view = await service.agencyAccount('t1', 'ag1')
    expect(view).toEqual({
      agency: { id: 'ag1', code: 'GULF', name: 'Gulf Travel', status: 'ACTIVE' },
      accounts: [{ currency: 'AED', status: 'NOT_OPENED', accountId: null, balanceMinor: '0', entryCount: 0, lastEntryAt: null, recent: [] }],
      fundingEnabled: false, bookingsPostTo: 'HOUSE',
    })
    expect(tx.agency.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ag1', tenantId: 't1' } }))
    expect(tx.wallet.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't1', agencyId: 'ag1' } }))
    expect(tx.ledgerEntry.groupBy).not.toHaveBeenCalled()
  })

  it('sums the whole ledger for an open account and lists the latest entries', async () => {
    delete process.env.SETTLEMENT_CURRENCIES
    const { service, tx } = setup({
      accounts: [{ id: 'w-ag', tenantId: 't1', agencyId: 'ag1', currency: 'AED', creditLimit: 0n, updatedAt: at }],
      sums: [{ walletId: 'w-ag', _sum: { amountMinor: 1_250_000n }, _count: { _all: 40 }, _max: { immutableAt: at } }],
      entries: { 'w-ag': [entry('e1', 'w-ag', 1_250_000n)] },
    })
    const [aed] = (await service.agencyAccount('t1', 'ag1')).accounts
    expect(aed).toMatchObject({ currency: 'AED', status: 'OPEN', accountId: 'w-ag', balanceMinor: '1250000', entryCount: 40, lastEntryAt: at.toISOString() })
    expect(aed.recent).toEqual([expect.objectContaining({ id: 'e1', amountMinor: '1250000', walletId: 'w-ag' })])
    expect(tx.ledgerEntry.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't1', walletId: { in: ['w-ag'] } } }))
    expect(tx.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
  })

  it('keeps an existing account in a currency that is no longer enabled, and adds the enabled ones as not opened', async () => {
    process.env.SETTLEMENT_CURRENCIES = 'AED'
    const { service } = setup({ accounts: [{ id: 'w-usd', tenantId: 't1', agencyId: 'ag1', currency: 'USD', creditLimit: 0n, updatedAt: at }], sums: [] })
    const accounts = (await service.agencyAccount('t1', 'ag1')).accounts
    expect(accounts.map(a => [a.currency, a.status, a.balanceMinor])).toEqual([['AED', 'NOT_OPENED', '0'], ['USD', 'OPEN', '0']])
  })

  it('answers 404 for an agency outside the tenant and 400 for a malformed id', async () => {
    await expect(setup({ agency: null }).service.agencyAccount('t1', 'ag-other')).rejects.toBeInstanceOf(NotFoundException)
    await expect(setup({}).service.agencyAccount('t1', "x' OR 1=1")).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('OperationsTransactionsService.wallets owner filter', () => {
  const house: Wallet = { id: 'w-h', tenantId: 't1', agencyId: null, currency: 'AED', creditLimit: 5n, updatedAt: at, agency: null }
  const agencyAcct: Wallet = { id: 'w-a', tenantId: 't1', agencyId: 'ag1', currency: 'AED', creditLimit: 0n, updatedAt: at, agency: { id: 'ag1', code: 'GULF', name: 'Gulf Travel' } }

  it('labels house and agency accounts', async () => {
    const { service } = setup({ accounts: [house, agencyAcct], sums: [] })
    const rows = (await service.wallets('t1', {})).items
    expect(rows.map(r => [r.id, r.owner, r.agency?.code ?? null])).toEqual([['w-h', 'HOUSE', null], ['w-a', 'AGENCY', 'GULF']])
  })

  it('translates owner and agencyId filters and rejects contradictions', async () => {
    const where = async (query: Record<string, unknown>) => { const { service, tx } = setup({}); await service.wallets('t1', query); return tx.wallet.findMany.mock.calls[0][0].where }
    expect(await where({ owner: 'HOUSE' })).toEqual({ tenantId: 't1', agencyId: null })
    expect(await where({ owner: 'AGENCY' })).toEqual({ tenantId: 't1', agencyId: { not: null } })
    expect(await where({ agencyId: 'ag1' })).toEqual({ tenantId: 't1', agencyId: 'ag1' })
    expect(await where({})).toEqual({ tenantId: 't1' })
    await expect(setup({}).service.wallets('t1', { owner: 'HOUSE', agencyId: 'ag1' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(setup({}).service.wallets('t1', { owner: 'house' })).rejects.toBeInstanceOf(BadRequestException)
  })
})
