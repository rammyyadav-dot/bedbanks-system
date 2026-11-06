import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LedgerEntryType } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency } from './currency'
import { refundWithin } from '@bedbanks/money'
import { appendLedgerEntry, assertValidAppend, referenceSumMinor, walletBalanceMinor } from '../ledger/ledger-core'
import { sanitizeAuditPayload } from './audit-payload'
import { lockAgencyCredit } from './agency-account'
import { assertSpendableUnderLock, lockWalletRow } from '../ledger/wallet-lock'

/** A refusal of a direct ledger adjustment. The audit is written after the money transaction rolls back (ADR 0113). */
class DirectLedgerRefusal extends Error {
  constructor(readonly http: BadRequestException | ConflictException | ForbiddenException, readonly code: string, readonly walletId: string | null) {
    super('direct ledger adjustment refused')
  }
}

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

        // A negative entry is a credit decrement. Lock the wallet before the idempotency read so a concurrent
        // debit waits, then re-checks what remains (ADR 0110). A replay of the same key does not spend again.
        const decreasesCredit = input.amountMinor < 0n
        if (decreasesCredit) {
          if (wallet.agencyId) await lockAgencyCredit(tx, wallet.agencyId)
          await lockWalletRow(tx, input.tenantId, wallet.id)
        }

        const existing = await tx.ledgerEntry.findUnique({ where: key })
        if (existing) {
          this.assertSameIntent(existing, input)
          return existing
        }

        if (decreasesCredit) await assertSpendableUnderLock(tx, wallet, -input.amountMinor)

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
   * A posted adjustment records the balance before and after. A replay of the same key records that the money did not move again.
   * A refusal (excess refund, insufficient credit, a key reused for different intent, a missing or wrong-currency account) is audited after the transaction rolls back.
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

    const signedMinor = input.type === 'DEBIT' ? -input.amountMinor : input.amountMinor
    try {
      if (input.type === 'REFUND' && input.authorizedRefundableMinor !== undefined) {
        this.assertRefundWithinAuthorized({
          refundMinor: input.amountMinor,
          authorizedRefundableMinor: input.authorizedRefundableMinor,
        })
      }
      return await this.prisma.withTenant(input.tenantId, async (tx) => {
        const wallet = input.walletId
          ? await tx.wallet.findFirst({ where: { id: input.walletId, tenantId: input.tenantId } })
          : await tx.wallet.findFirst({ where: { tenantId: input.tenantId, currency: input.currency } })

        if (!wallet) throw new DirectLedgerRefusal(new ForbiddenException('Wallet is unavailable for tenant and currency'), 'WALLET_UNAVAILABLE', input.walletId ?? null)
        if (wallet.currency !== input.currency) throw new DirectLedgerRefusal(new ConflictException('Wallet currency mismatch'), 'CURRENCY_MISMATCH', wallet.id)

        await lockWalletRow(tx, input.tenantId, wallet.id)

        const key = { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey }, tenantId: input.tenantId }
        const existing = await tx.ledgerEntry.findUnique({ where: key })
        if (existing) {
          try {
            this.assertSameIntent(existing, {
              tenantId: input.tenantId,
              currency: input.currency,
              amountMinor: signedMinor,
              type: input.type,
              reference,
            })
          } catch (error) {
            if (error instanceof ConflictException) throw new DirectLedgerRefusal(error, 'IDEMPOTENCY_CONFLICT', wallet.id)
            throw error
          }
          await tx.auditEvent.create({ data: {
            tenantId: input.tenantId, userId: input.userId, actorType: 'USER', action: 'finance.ledger.adjustment_replayed', entityType: 'ledger_entry', entityId: existing.id,
            payload: sanitizeAuditPayload({ outcome: 'replayed', requestId: input.requestId ?? null, walletId: wallet.id, ledgerEntryId: existing.id, type: input.type, currency: input.currency, amountMinor: signedMinor.toString(), reference, idempotencyKey }),
          } })
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
          try {
            this.assertRefundWithinAuthorized({
              refundMinor: absPrior + input.amountMinor,
              authorizedRefundableMinor: input.authorizedRefundableMinor,
            })
          } catch (error) {
            if (error instanceof BadRequestException) throw new DirectLedgerRefusal(error, 'REFUND_EXCEEDS_AUTHORIZED', wallet.id)
            throw error
          }
        }

        const balanceBefore = await walletBalanceMinor(tx, input.tenantId, wallet.id, input.currency)
        if (input.type === 'DEBIT' && wallet.creditLimit + balanceBefore + signedMinor < 0n) {
          throw new DirectLedgerRefusal(new ConflictException('Insufficient B2B agency credit limit for debit adjustment'), 'INSUFFICIENT_CREDIT', wallet.id)
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

        await tx.auditEvent.create({ data: {
          tenantId: input.tenantId, userId: input.userId, actorType: 'USER', action: 'finance.ledger.adjustment_posted', entityType: 'ledger_entry', entityId: entry.id,
          payload: sanitizeAuditPayload({
            outcome: 'allowed', requestId: input.requestId ?? null, walletId: wallet.id, type: input.type, currency: input.currency,
            amountMinor: signedMinor.toString(), reference, idempotencyKey, balanceBeforeMinor: balanceBefore.toString(), balanceAfterMinor: durableBalance.toString(),
          }),
        } })

        return {
          entry,
          walletId: wallet.id,
          durableBalanceMinor: durableBalance,
          creditLimitMinor: wallet.creditLimit,
          availableCreditMinor: wallet.creditLimit + durableBalance,
        }
      })
    } catch (error) {
      if (error instanceof DirectLedgerRefusal) {
        await this.recordDirectRefusal(input, signedMinor, reference, idempotencyKey, error).catch(() => undefined)
        throw error.http
      }
      if (error instanceof BadRequestException && error.message.includes('Refund exceeds authorized')) {
        await this.recordDirectRefusal(input, signedMinor, reference, idempotencyKey, new DirectLedgerRefusal(error, 'REFUND_EXCEEDS_AUTHORIZED', input.walletId ?? null)).catch(() => undefined)
      }
      throw error
    }
  }

  private recordDirectRefusal(input: { tenantId: string; userId: string; requestId?: string; currency: string; type: string }, signedMinor: bigint, reference: string, idempotencyKey: string, refusal: DirectLedgerRefusal) {
    return this.prisma.withTenant(input.tenantId, (tx) => tx.auditEvent.create({ data: {
      tenantId: input.tenantId, userId: input.userId, actorType: 'USER', action: 'finance.ledger.adjustment_denied', entityType: refusal.walletId ? 'wallet' : 'ledger_entry', entityId: refusal.walletId ?? input.currency,
      payload: sanitizeAuditPayload({
        outcome: 'denied', code: refusal.code, requestId: input.requestId ?? null, walletId: refusal.walletId, type: input.type, currency: input.currency,
        amountMinor: signedMinor.toString(), reference, idempotencyKey,
      }),
    } }))
  }

  private assertSameIntent(existing: { tenantId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; reference: string | null },
    input: { tenantId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; reference?: string }) {
    if (existing.tenantId !== input.tenantId || existing.currency !== input.currency || existing.amountMinor !== input.amountMinor ||
      existing.type !== input.type || existing.reference !== (input.reference ?? null)) {
      throw new ConflictException('Ledger idempotency key was reused with different financial intent')
    }
  }
}
