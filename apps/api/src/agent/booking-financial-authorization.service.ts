import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency } from './currency'

export interface FinancialAuthorizationCommand {
  tenantId: string
  userId: string
  requestId: string
  walletId: string
  bookingId: string
  currency: string
  amountMinor: bigint
  idempotencyKey: string
}

@Injectable()
export class BookingFinancialAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async authorize(command: FinancialAuthorizationCommand) {
    this.validate(command)
    const key = { walletId_idempotencyKey: { walletId: command.walletId, idempotencyKey: command.idempotencyKey } }

    try {
      return await this.prisma.withTenant(command.tenantId, async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
            FROM "Wallet"
           WHERE "id" = ${command.walletId}
             AND "tenant_id" = ${command.tenantId}
           FOR UPDATE
        `)
        if (locked.length !== 1) throw new ForbiddenException('Wallet is unavailable')

        const wallet = await tx.wallet.findFirst({ where: { id: command.walletId, tenantId: command.tenantId } })
        if (!wallet) throw new ForbiddenException('Wallet is unavailable')
        if (wallet.currency !== command.currency) throw new ConflictException('Wallet currency mismatch')

        const existing = await tx.ledgerEntry.findUnique({ where: key })
        if (existing) {
          this.assertSameAuthorization(existing, command)
          return existing
        }

        const aggregate = await tx.ledgerEntry.aggregate({
          where: { tenantId: command.tenantId, walletId: command.walletId, currency: command.currency },
          _sum: { amountMinor: true },
        })
        const durableBalance = aggregate._sum.amountMinor ?? 0n
        const availableCredit = durableBalance + wallet.creditLimit
        if (availableCredit < command.amountMinor) throw new ConflictException('Insufficient wallet credit')

        const entry = await tx.ledgerEntry.create({
          data: {
            tenantId: command.tenantId,
            walletId: command.walletId,
            type: 'HOLD',
            amountMinor: -command.amountMinor,
            currency: command.currency,
            reference: `booking:${command.bookingId}`,
            idempotencyKey: command.idempotencyKey,
          },
        })

        await tx.auditEvent.create({
          data: {
            tenantId: command.tenantId,
            userId: command.userId,
            actorType: 'USER',
            action: 'booking.finance.authorized',
            entityType: 'booking',
            entityId: command.bookingId,
            payload: { requestId: command.requestId, walletId: command.walletId, currency: command.currency, amountMinor: command.amountMinor.toString() },
          },
        })
        return entry
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error

      return this.prisma.withTenant(command.tenantId, async tx => {
        const raced = await tx.ledgerEntry.findUnique({ where: key })
        if (!raced) throw error
        this.assertSameAuthorization(raced, command)
        return raced
      })
    }
  }


  async release(command: FinancialAuthorizationCommand) {
    this.validate(command)
    const authorizationKey = { walletId_idempotencyKey: { walletId: command.walletId, idempotencyKey: command.idempotencyKey } }
    const releaseKey = { walletId_idempotencyKey: { walletId: command.walletId, idempotencyKey: `${command.idempotencyKey}:release` } }

    try {
      return await this.prisma.withTenant(command.tenantId, async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "Wallet"
           WHERE "id" = ${command.walletId} AND "tenant_id" = ${command.tenantId}
           FOR UPDATE
        `)
        if (locked.length !== 1) throw new ForbiddenException('Wallet is unavailable')

        const authorization = await tx.ledgerEntry.findUnique({ where: authorizationKey })
        if (!authorization) throw new ConflictException('Financial authorization is unavailable')
        this.assertSameAuthorization(authorization, command)

        const existing = await tx.ledgerEntry.findUnique({ where: releaseKey })
        if (existing) {
          this.assertSameRelease(existing, command)
          return existing
        }

        const entry = await tx.ledgerEntry.create({ data: {
          tenantId: command.tenantId, walletId: command.walletId, type: 'RELEASE',
          amountMinor: command.amountMinor, currency: command.currency,
          reference: `booking:${command.bookingId}`, idempotencyKey: `${command.idempotencyKey}:release`,
        } })
        await tx.auditEvent.create({ data: {
          tenantId: command.tenantId, userId: command.userId, actorType: 'USER',
          action: 'booking.finance.released', entityType: 'booking', entityId: command.bookingId,
          payload: { requestId: command.requestId, walletId: command.walletId, currency: command.currency, amountMinor: command.amountMinor.toString() },
        } })
        return entry
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      return this.prisma.withTenant(command.tenantId, async tx => {
        const raced = await tx.ledgerEntry.findUnique({ where: releaseKey })
        if (!raced) throw error
        this.assertSameRelease(raced, command)
        return raced
      })
    }
  }

  private assertSameRelease(existing: {
    tenantId: string; walletId: string; type: string; amountMinor: bigint; currency: string; reference: string | null
  }, command: FinancialAuthorizationCommand): void {
    if (existing.tenantId !== command.tenantId || existing.walletId !== command.walletId || existing.type !== 'RELEASE' ||
      existing.amountMinor !== command.amountMinor || existing.currency !== command.currency ||
      existing.reference !== `booking:${command.bookingId}`) {
      throw new ConflictException('Financial release idempotency key was reused with different intent')
    }
  }

  private validate(command: FinancialAuthorizationCommand): void {
    assertSupportedSettlementCurrency(command.currency)
    for (const value of [command.tenantId, command.userId, command.requestId, command.walletId, command.bookingId, command.idempotencyKey]) {
      if (!value || value.trim() !== value) throw new BadRequestException('Invalid financial authorization command')
    }
    if (command.amountMinor <= 0n) throw new BadRequestException('Authorization amount must be positive')
  }

  private assertSameAuthorization(existing: {
    tenantId: string
    walletId: string
    type: string
    amountMinor: bigint
    currency: string
    reference: string | null
  }, command: FinancialAuthorizationCommand): void {
    if (
      existing.tenantId !== command.tenantId ||
      existing.walletId !== command.walletId ||
      existing.type !== 'HOLD' ||
      existing.amountMinor !== -command.amountMinor ||
      existing.currency !== command.currency ||
      existing.reference !== `booking:${command.bookingId}`
    ) {
      throw new ConflictException('Financial authorization idempotency key was reused with different intent')
    }
  }
}
