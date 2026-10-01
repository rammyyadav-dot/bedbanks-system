import { AgentFinanceService } from './finance.service'

function setup(wallets: Array<{ id: string; currency: string; creditLimit: bigint }>, sum: bigint | null, entries: Array<{ amountMinor: bigint }> = []) {
  const tx = {
    wallet: { findMany: jest.fn().mockResolvedValue(wallets) },
    ledgerEntry: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: sum } }), findMany: jest.fn().mockResolvedValue(entries) },
  }
  const prisma = { withTenant: jest.fn((_t: string, work: (t: unknown) => unknown) => work(tx)) }
  return { service: new AgentFinanceService(prisma as never), tx }
}

describe('AgentFinanceService.summary', () => {
  it('prefers the AED wallet and computes the balance from the whole ledger, not the displayed page', async () => {
    const { service, tx } = setup([{ id: 'w-usd', currency: 'USD', creditLimit: 1n }, { id: 'w-aed', currency: 'AED', creditLimit: 5_000_000n }], -125_099n, [{ amountMinor: -1n }])
    const result = await service.summary('tenant-a')
    expect(result).toMatchObject({ status: 'active', currency: 'AED', balance: '-125099', creditLimit: '5000000', availableCredit: '4874901' })
    expect(tx.ledgerEntry.aggregate).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a', walletId: 'w-aed' }, _sum: { amountMinor: true } })
    expect(tx.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
  })
  it('shows the only wallet when it is not AED, a zero balance for an empty ledger, and not_configured with none', async () => {
    expect(await setup([{ id: 'w', currency: 'USD', creditLimit: 100n }], null).service.summary('t')).toMatchObject({ status: 'active', currency: 'USD', balance: '0', availableCredit: '100' })
    expect(await setup([], null).service.summary('t')).toMatchObject({ status: 'not_configured', availableCredit: null, ledger: [] })
  })
})
