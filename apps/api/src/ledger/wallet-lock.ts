import { ConflictException, ForbiddenException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { canSpend } from '@bedbanks/money'
import { accountCreditLineMinor } from '../agent/agency-account'
import { walletBalanceMinor } from './ledger-core'

/**
 * The wallet row lock every credit decrement takes (ADR 0110). `FOR UPDATE` is held until the caller's transaction
 * ends, so the balance read, the spend check and the ledger append that follows cannot interleave with another
 * decrement on the same account. The hash-chain trigger locks this same row (`FOR NO KEY UPDATE`); taking the
 * stronger lock here first keeps that order. Tenant-scoped: a wallet the current tenant cannot see locks nothing.
 */
export async function lockWalletRow(tx: Prisma.TransactionClient, tenantId: string, walletId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
      FROM "Wallet"
     WHERE "id" = ${walletId}
       AND "tenant_id" = ${tenantId}
     FOR UPDATE
  `)
  if (locked.length !== 1) throw new ForbiddenException('Wallet is unavailable')
}

type SpendWallet = { id: string; tenantId: string; agencyId: string | null; currency: string; creditLimit: bigint }

/**
 * Balance plus credit line, read while the caller already holds `lockWalletRow` on this wallet.
 * Refuses a decrement the account cannot cover. Returns the balance that decision used.
 */
export async function assertSpendableUnderLock(tx: Prisma.TransactionClient, wallet: SpendWallet, amountMinor: bigint): Promise<bigint> {
  const balanceMinor = await walletBalanceMinor(tx, wallet.tenantId, wallet.id, wallet.currency)
  const creditLineMinor = await accountCreditLineMinor(tx, wallet)
  if (!canSpend({ balanceMinor, creditLineMinor }, amountMinor)) throw new ConflictException('Insufficient wallet credit')
  return balanceMinor
}
