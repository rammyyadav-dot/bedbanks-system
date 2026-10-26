import { commissionGrossBookedVolume } from './commission-volume'

describe('commissionGrossBookedVolume', () => {
  const postings = (sum: { salesMinor: bigint | null; refundsMinor: bigint | null } | null) => ({
    withTenant: jest.fn(async (_tenantId: string, work: (tx: unknown) => unknown) =>
      work({ bookingFinancePosting: { aggregate: jest.fn().mockResolvedValue({ _sum: sum ?? { salesMinor: null, refundsMinor: null } }) } }),
    ),
  })

  it('returns zero without querying postings when the agency has no wallet in that currency', async () => {
    const tx = { wallet: { findMany: jest.fn().mockResolvedValue([]) } }
    const db = postings(null)
    expect(await commissionGrossBookedVolume(tx as never, db as never, 't1', 'ag1', 'AED', '2026-09-01', '2026-10-01')).toBe(0n)
    expect(db.withTenant).not.toHaveBeenCalled()
  })

  it('nets sales less refunds across every matching wallet', async () => {
    const tx = { wallet: { findMany: jest.fn().mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]) } }
    const db = postings({ salesMinor: 500_000n, refundsMinor: 50_000n })
    expect(await commissionGrossBookedVolume(tx as never, db as never, 't1', 'ag1', 'AED', '2026-09-01', '2026-10-01')).toBe(450_000n)
    expect(tx.wallet.findMany).toHaveBeenCalledWith({ where: { tenantId: 't1', agencyId: 'ag1', currency: 'AED' }, select: { id: true } })
  })

  it('floors at zero rather than returning a negative gross volume when refunds outweigh sales', async () => {
    const tx = { wallet: { findMany: jest.fn().mockResolvedValue([{ id: 'w1' }]) } }
    const db = postings({ salesMinor: 10_000n, refundsMinor: 90_000n })
    expect(await commissionGrossBookedVolume(tx as never, db as never, 't1', 'ag1', 'AED', '2026-09-01', '2026-10-01')).toBe(0n)
  })

  it('treats no posted rows as zero volume, never as an error', async () => {
    const tx = { wallet: { findMany: jest.fn().mockResolvedValue([{ id: 'w1' }]) } }
    const db = postings(null)
    expect(await commissionGrossBookedVolume(tx as never, db as never, 't1', 'ag1', 'AED', '2026-09-01', '2026-10-01')).toBe(0n)
  })
})
