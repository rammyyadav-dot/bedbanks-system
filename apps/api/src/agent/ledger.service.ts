import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LedgerEntryType } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency } from './currency'

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Posts one append-only minor-unit entry, idempotently, inside the tenant RLS transaction. */
  async post(input: { tenantId: string; walletId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; idempotencyKey: string; reference?: string }) {
    assertSupportedSettlementCurrency(input.currency)
    if (!input.idempotencyKey.trim()) throw new BadRequestException('Ledger idempotency key is required')
    if (input.amountMinor === 0n) throw new BadRequestException('Ledger amount must be non-zero')

    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const wallet = await tx.wallet.findFirst({ where: { id: input.walletId, tenantId: input.tenantId } })
      if (!wallet) throw new ForbiddenException('Wallet is unavailable')
      if (wallet.currency !== input.currency) throw new ConflictException('Wallet currency mismatch')

      const key = { walletId_idempotencyKey: { walletId: input.walletId, idempotencyKey: input.idempotencyKey } }
      const existing = await tx.ledgerEntry.findUnique({ where: key })
      if (existing) {
        this.assertSameIntent(existing, input)
        return existing
      }

      try {
        return await tx.ledgerEntry.create({
          data: {
            tenantId: input.tenantId,
            walletId: input.walletId,
            currency: input.currency,
            amountMinor: input.amountMinor,
            type: input.type,
            idempotencyKey: input.idempotencyKey,
            reference: input.reference,
          },
        })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
        const raced = await tx.ledgerEntry.findUnique({ where: key })
        if (!raced) throw error
        this.assertSameIntent(raced, input)
        return raced
      }
    })
  }

  assertRefundWithinAuthorized(input: { refundMinor: bigint; authorizedRefundableMinor: bigint }) {
    if (input.refundMinor < 0n || input.authorizedRefundableMinor < 0n || input.refundMinor > input.authorizedRefundableMinor) {
      throw new BadRequestException('Refund exceeds authorized refundable amount')
    }
  }

  private assertSameIntent(existing: { tenantId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; reference: string | null },
    input: { tenantId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; reference?: string }) {
    if (existing.tenantId !== input.tenantId || existing.currency !== input.currency || existing.amountMinor !== input.amountMinor ||
      existing.type !== input.type || existing.reference !== (input.reference ?? null)) {
      throw new ConflictException('Ledger idempotency key was reused with different financial intent')
    }
  }
}
