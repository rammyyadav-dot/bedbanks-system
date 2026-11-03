import { ConflictException, ForbiddenException } from '@nestjs/common'
import { assertSpendableUnderLock, lockWalletRow } from './wallet-lock'

const wallet = { id: 'w1', tenantId: 't1', agencyId: null, currency: 'AED', creditLimit: 1_000n }

function tx(input: { locked?: Array<{ id: string }>; balance?: bigint } = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(input.locked ?? [{ id: 'w1' }]),
    ledgerEntry: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountMinor: input.balance ?? 0n } }) },
  }
}

describe('wallet row lock', () => {
  it('locks the tenant wallet row and refuses a row the tenant cannot see', async () => {
    const seen = tx()
    await expect(lockWalletRow(seen as never, 't1', 'w1')).resolves.toBeUndefined()
    expect(seen.$queryRaw).toHaveBeenCalledTimes(1)

    const missing = tx({ locked: [] })
    await expect(lockWalletRow(missing as never, 't1', 'w1')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('allows a decrement that fits the locked balance and refuses one that does not', async () => {
    await expect(assertSpendableUnderLock(tx({ balance: 500n }) as never, wallet, 1_500n)).resolves.toBe(500n)
    const refused = tx({ balance: 0n })
    await expect(assertSpendableUnderLock(refused as never, wallet, 1_001n)).rejects.toBeInstanceOf(ConflictException)
    expect(refused.ledgerEntry.aggregate).toHaveBeenCalledTimes(1)
  })

  it('spends an agency credit line, not the wallet column, which stays zero on agency accounts', async () => {
    const agency = { ...wallet, agencyId: 'ag', creditLimit: 0n }
    const client = {
      ...tx({ balance: 0n }),
      agencyCreditLimit: { findFirst: jest.fn().mockResolvedValue({ currency: 'AED', limitMinor: 2_000n }) },
    }
    await expect(assertSpendableUnderLock(client as never, agency, 2_000n)).resolves.toBe(0n)
    await expect(assertSpendableUnderLock(client as never, agency, 2_001n)).rejects.toBeInstanceOf(ConflictException)
  })
})
