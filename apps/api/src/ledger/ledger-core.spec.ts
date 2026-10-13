import { BadRequestException } from '@nestjs/common'
import { appendLedgerEntry, ledgerWindowGroups, totalsOf, walletBalanceMinor, walletTotals } from './ledger-core'

const base = { tenantId: 't1', walletId: 'w1', currency: 'AED', idempotencyKey: 'k1' }
const txWith = (over: Record<string, jest.Mock> = {}) => ({ ledgerEntry: { create: jest.fn().mockResolvedValue({ id: 'e1' }), aggregate: jest.fn(), groupBy: jest.fn(), ...over } }) as never

describe('ledger-core', () => {
  it('appends with the stored signed amount and the reference only when given', async () => {
    const tx = txWith()
    await appendLedgerEntry(tx, { ...base, type: 'HOLD', amountMinor: -500n, reference: 'booking:b1' })
    await appendLedgerEntry(tx, { ...base, type: 'CREDIT', amountMinor: 500n })
    const create = (tx as unknown as { ledgerEntry: { create: jest.Mock } }).ledgerEntry.create
    expect(create).toHaveBeenNthCalledWith(1, { data: { tenantId: 't1', walletId: 'w1', type: 'HOLD', amountMinor: -500n, currency: 'AED', idempotencyKey: 'k1', reference: 'booking:b1' } })
    expect(create.mock.calls[1][0].data).not.toHaveProperty('reference')
  })

  it.each([
    ['wrong sign for HOLD', { type: 'HOLD', amountMinor: 1n }],
    ['wrong sign for REFUND', { type: 'REFUND', amountMinor: -1n }],
    ['zero amount', { type: 'CREDIT', amountMinor: 0n }],
    ['blank idempotency key', { type: 'CREDIT', amountMinor: 1n, idempotencyKey: '  ' }],
    ['non ISO currency', { type: 'CREDIT', amountMinor: 1n, currency: 'aed' }],
  ])('refuses %s before touching the database', async (_name, over) => {
    const tx = txWith()
    await expect(Promise.resolve().then(() => appendLedgerEntry(tx, { ...base, ...(over as object) } as never))).rejects.toBeInstanceOf(BadRequestException)
    expect((tx as unknown as { ledgerEntry: { create: jest.Mock } }).ledgerEntry.create).not.toHaveBeenCalled()
  })

  it('balance is the ledger sum, optionally pinned to a currency, and zero when empty', async () => {
    const aggregate = jest.fn().mockResolvedValueOnce({ _sum: { amountMinor: 700n } }).mockResolvedValueOnce({ _sum: { amountMinor: null } })
    const tx = txWith({ aggregate })
    expect(await walletBalanceMinor(tx, 't1', 'w1', 'AED')).toBe(700n)
    expect(aggregate).toHaveBeenCalledWith({ where: { tenantId: 't1', walletId: 'w1', currency: 'AED' }, _sum: { amountMinor: true } })
    expect(await walletBalanceMinor(tx, 't1', 'w1')).toBe(0n)
    expect(aggregate).toHaveBeenLastCalledWith({ where: { tenantId: 't1', walletId: 'w1' }, _sum: { amountMinor: true } })
  })

  it('totals group by wallet; a wallet with no entries reads as zero and an empty id list is not queried', async () => {
    const at = new Date('2026-10-01T00:00:00Z')
    const groupBy = jest.fn().mockResolvedValue([{ walletId: 'w1', _sum: { amountMinor: -300n }, _count: { _all: 3 }, _max: { immutableAt: at } }])
    const tx = txWith({ groupBy })
    const totals = await walletTotals(tx, 't1', ['w1', 'w2'])
    expect(totalsOf(totals, 'w1')).toEqual({ balanceMinor: -300n, entryCount: 3, lastEntryAt: at })
    expect(totalsOf(totals, 'w2')).toEqual({ balanceMinor: 0n, entryCount: 0, lastEntryAt: null })
    groupBy.mockClear()
    expect((await walletTotals(tx, 't1', [])).size).toBe(0)
    expect(groupBy).not.toHaveBeenCalled()
  })

  it('window groups keep currencies as separate rows', async () => {
    const groupBy = jest.fn().mockResolvedValue([{ currency: 'AED', type: 'CREDIT', _sum: { amountMinor: 5n }, _count: { _all: 1 } }, { currency: 'USD', type: 'CREDIT', _sum: { amountMinor: null }, _count: { _all: 2 } }])
    const rows = await ledgerWindowGroups(txWith({ groupBy }), 't1', { start: new Date(0), end: new Date(1) })
    expect(rows).toEqual([{ currency: 'AED', type: 'CREDIT', sumMinor: 5n, entries: 1 }, { currency: 'USD', type: 'CREDIT', sumMinor: 0n, entries: 2 }])
  })
})
