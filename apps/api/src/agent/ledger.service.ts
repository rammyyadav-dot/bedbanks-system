import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LedgerEntryType } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency } from './currency'
import { refundWithin } from '@bedbanks/money'
import { appendLedgerEntry, assertValidAppend, referenceSumMinor, walletBalanceMinor } from '../ledger/ledger-core'

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Posts one append-only minor-unit entry, idempotently, inside the tenant RLS transaction. */
  async post(input: { tenantId: string; walletId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; idempotencyKey: string; reference?: string }) {
    assertSupportedSettlementCurrency(input.currency)
    assertValidAppend(input)

    const key = { walletId_idempotencyKey: { walletId: input.walletId, idempotencyKey: input.idempotencyKey }, tenantId: input.tenantId }

    try {
      return await this.prisma.withTenant(input.tenantId, async (tx) => {
        const wallet = await tx.wallet.findFirst({ where: { id: input.walletId, tenantId: input.tenantId } })
        if (!wallet) throw new ForbiddenException('Wallet is unavailable')
        if (wallet.currency !== input.currency) throw new ConflictException('Wallet currency mismatch')

        const existing = await tx.ledgerEntry.findUnique({ where: key })
        if (existing) {
          this.assertSameIntent(existing, input)
          return existing
        }

        return appendLedgerEntry(tx, input)
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error

      return this.prisma.withTenant(input.tenantId, async (tx) => {
        const raced = await tx.ledgerEntry.findUnique({ where: key })
        if (!raced) throw error
        this.assertSameIntent(raced, input)
        return raced
      })
    }
  }

  assertRefundWithinAuthorized(input: { refundMinor: bigint; authorizedRefundableMinor: bigint }) {
    if (!refundWithin(input)) {
      throw new BadRequestException('Refund exceeds authorized refundable amount')
    }
  }

  /**
   * Connects cancellation refunds and commercial adjustments directly to B2B agency credit limits
   * and append-only ledger posting tables. Locks the tenant wallet FOR UPDATE, prevents excess
   * cumulative refunds against a booking reference, updates cachedBalance, and records an audit event.
   */
  async postB2BLedgerAdjustment(input: {
    tenantId: string
    userId: string
    requestId?: string
    walletId?: string
    currency: string
    type: 'REFUND' | 'CREDIT' | 'DEBIT' | 'RELEASE'
    amountMinor: bigint
    authorizedRefundableMinor?: bigint
    reference: string
    idempotencyKey: string
  }) {
    assertSupportedSettlementCurrency(input.currency)
    const idempotencyKey = input.idempotencyKey.trim()
    const reference = input.reference.trim()
    if (!idempotencyKey || !reference) throw new BadRequestException('Ledger idempotencyKey and reference are required')
    if (input.amountMinor <= 0n) throw new BadRequestException('Adjustment amountMinor must be positive')

    if (input.type === 'REFUND' && input.authorizedRefundableMinor !== undefined) {
      this.assertRefundWithinAuthorized({
        refundMinor: input.amountMinor,
        authorizedRefundableMinor: input.authorizedRefundableMinor,
      })
    }

    const signedMinor = input.type === 'DEBIT' ? -input.amountMinor : input.amountMinor

    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const wallet = input.walletId
        ? await tx.wallet.findFirst({ where: { id: input.walletId, tenantId: input.tenantId } })
        : await tx.wallet.findFirst({ where: { tenantId: input.tenantId, currency: input.currency } })

      if (!wallet) throw new ForbiddenException('Wallet is unavailable for tenant and currency')
      if (wallet.currency !== input.currency) throw new ConflictException('Wallet currency mismatch')

      await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
          FROM "Wallet"
         WHERE "id" = ${wallet.id}
           AND "tenant_id" = ${input.tenantId}
         FOR UPDATE
      `)

      const key = { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey }, tenantId: input.tenantId }
      const existing = await tx.ledgerEntry.findUnique({ where: key })
      if (existing) {
        this.assertSameIntent(existing, {
          tenantId: input.tenantId,
          currency: input.currency,
          amountMinor: signedMinor,
          type: input.type,
          reference,
        })
        const durableBalance = await walletBalanceMinor(tx, input.tenantId, wallet.id, input.currency)
        return {
          entry: existing,
          walletId: wallet.id,
          durableBalanceMinor: durableBalance,
          creditLimitMinor: wallet.creditLimit,
          availableCreditMinor: wallet.creditLimit + durableBalance,
        }
      }

      if (input.type === 'REFUND' && input.authorizedRefundableMinor !== undefined) {
        const cumulativePrior = await referenceSumMinor(tx, input.tenantId, wallet.id, reference, 'REFUND')
        const absPrior = cumulativePrior < 0n ? -cumulativePrior : cumulativePrior
        this.assertRefundWithinAuthorized({
          refundMinor: absPrior + input.amountMinor,
          authorizedRefundableMinor: input.authorizedRefundableMinor,
        })
      }

      const balanceBefore = await walletBalanceMinor(tx, input.tenantId, wallet.id, input.currency)
      if (input.type === 'DEBIT' && wallet.creditLimit + balanceBefore + signedMinor < 0n) {
        throw new ConflictException('Insufficient B2B agency credit limit for debit adjustment')
      }

      const entry = await appendLedgerEntry(tx, {
        tenantId: input.tenantId,
        walletId: wallet.id,
        currency: input.currency,
        amountMinor: signedMinor,
        type: input.type,
        idempotencyKey,
        reference,
      })

      const durableBalance = balanceBefore + signedMinor
      await tx.wallet.update({
        where: { id: wallet.id, tenantId: input.tenantId },
        data: { cachedBalance: durableBalance },
      })

      await tx.auditEvent.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          actorType: 'USER',
          action: 'finance.ledger.adjustment_posted',
          entityType: 'ledger_entry',
          entityId: entry.id,
          payload: {
            outcome: 'allowed',
            requestId: input.requestId ?? null,
            walletId: wallet.id,
            type: input.type,
            currency: input.currency,
            amountMinor: signedMinor.toString(),
            reference,
          },
        },
      })

      return {
        entry,
        walletId: wallet.id,
        durableBalanceMinor: durableBalance,
        creditLimitMinor: wallet.creditLimit,
        availableCreditMinor: wallet.creditLimit + durableBalance,
      }
    })
  }

  private assertSameIntent(existing: { tenantId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; reference: string | null },
    input: { tenantId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; reference?: string }) {
    if (existing.tenantId !== input.tenantId || existing.currency !== input.currency || existing.amountMinor !== input.amountMinor ||
      existing.type !== input.type || existing.reference !== (input.reference ?? null)) {
      throw new ConflictException('Ledger idempotency key was reused with different financial intent')
    }
  }
}
