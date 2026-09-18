import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import type { LedgerEntryType } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Posts one append-only minor-unit entry, idempotently, inside the tenant RLS transaction. */
  async post(input: { tenantId: string; walletId: string; currency: string; amountMinor: bigint; type: LedgerEntryType; idempotencyKey: string; reference?: string }) {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const wallet = await tx.wallet.findFirst({ where: { id: input.walletId, tenantId: input.tenantId } })
      if (!wallet) throw new ForbiddenException('Wallet is unavailable')
      if (wallet.currency !== input.currency) throw new ConflictException('Wallet currency mismatch')

      const existing = await tx.ledgerEntry.findUnique({ where: { walletId_idempotencyKey: { walletId: input.walletId, idempotencyKey: input.idempotencyKey } } })
      if (existing) return existing

      return tx.ledgerEntry.create({
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
    })
  }
}
