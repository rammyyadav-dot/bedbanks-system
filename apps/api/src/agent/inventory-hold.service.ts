import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import type { InventoryHoldRequest, InventoryHoldResponse } from '@bedbanks/domain'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency } from './currency'

export interface AuthoritativeHoldCommand extends InventoryHoldRequest {
  tenantId: string
  userId: string
  requestId: string
}

export function stayDates(checkIn: string, checkOut: string): Date[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) throw new BadRequestException('Invalid stay dates')
  const start = Date.parse(`${checkIn}T00:00:00.000Z`), end = Date.parse(`${checkOut}T00:00:00.000Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new BadRequestException('Invalid stay dates')
  const nights = Math.round((end - start) / 86_400_000)
  if (nights < 1 || nights > 30) throw new BadRequestException('Invalid stay length')
  return Array.from({ length: nights }, (_, index) => new Date(start + index * 86_400_000))
}

export function holdFingerprint(input: InventoryHoldRequest): string {
  const canonical = {
    offerId: input.offerId, searchId: input.searchId, ratePlanId: input.ratePlanId,
    canonicalHotelId: input.canonicalHotelId, canonicalRoomTypeId: input.canonicalRoomTypeId,
    boardBasisId: input.boardBasisId, checkIn: input.checkIn, checkOut: input.checkOut,
    rooms: input.rooms, currency: input.currency, sellAmountMinor: input.sellAmountMinor,
    offerExpiresAt: input.offerExpiresAt,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

@Injectable()
export class InventoryHoldService {
  constructor(private readonly prisma: PrismaService) {}

  async create(command: AuthoritativeHoldCommand): Promise<InventoryHoldResponse> {
    this.validate(command)
    const fingerprint = holdFingerprint(command)
    try {
      return await this.prisma.withTenant(command.tenantId, async (tx) => {
        const existing = await tx.inventoryHold.findUnique({
          where: { tenantId_idempotencyKey: { tenantId: command.tenantId, idempotencyKey: command.idempotencyKey } },
        })
        if (existing) return this.existing(existing, fingerprint)

        const holdExpiry = new Date(Math.min(Date.parse(command.offerExpiresAt), Date.now() + 15 * 60_000))
        const hold = await tx.inventoryHold.create({ data: {
          tenantId: command.tenantId, ratePlanId: command.ratePlanId, offerId: command.offerId,
          searchId: command.searchId, canonicalHotelId: command.canonicalHotelId,
          canonicalRoomTypeId: command.canonicalRoomTypeId, boardBasisId: command.boardBasisId,
          checkIn: new Date(`${command.checkIn}T00:00:00.000Z`), checkOut: new Date(`${command.checkOut}T00:00:00.000Z`),
          rooms: command.rooms, currency: command.currency, sellAmountMinor: BigInt(command.sellAmountMinor),
          idempotencyKey: command.idempotencyKey, requestFingerprint: fingerprint, requestId: command.requestId,
          createdByUserId: command.userId, status: 'HOLD_PENDING', expiresAt: holdExpiry,
        } })

        for (const stayDate of stayDates(command.checkIn, command.checkOut)) {
          const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            UPDATE "DailyAvailability"
               SET "held" = "held" + ${command.rooms}, "updated_at" = CURRENT_TIMESTAMP
             WHERE "tenant_id" = ${command.tenantId}
               AND "rate_plan_id" = ${command.ratePlanId}
               AND "stay_date" = ${stayDate}
               AND "stop_sell" = false
               AND "sold" + "held" + ${command.rooms} <= "allotment"
            RETURNING "id"
          `)
          if (rows.length !== 1) throw new ConflictException('Inventory unavailable')
          await tx.inventoryHoldNight.create({ data: {
            tenantId: command.tenantId, holdId: hold.id, availabilityId: rows[0].id,
            stayDate, quantity: command.rooms,
          } })
        }

        const active = await tx.inventoryHold.update({ where: { id: hold.id }, data: { status: 'HELD' } })
        await tx.auditEvent.create({ data: { tenantId: command.tenantId, userId: command.userId, actorType: 'USER',
          action: 'inventory.hold.created', entityType: 'inventory_hold', entityId: hold.id,
          payload: { requestId: command.requestId, ratePlanId: command.ratePlanId, rooms: command.rooms, checkIn: command.checkIn, checkOut: command.checkOut },
        } })
        return this.response(active, 'held')
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.withTenant(command.tenantId, async tx => {
          const existing = await tx.inventoryHold.findUniqueOrThrow({
            where: { tenantId_idempotencyKey: { tenantId: command.tenantId, idempotencyKey: command.idempotencyKey } },
          })
          return this.existing(existing, fingerprint)
        })
      }
      throw error
    }
  }

  async release(tenantId: string, holdId: string, requestId: string,
    actor: { type: 'USER'; userId: string } | { type: 'SYSTEM' }, expired = false): Promise<void> {
    await this.prisma.withTenant(tenantId, async tx => {
      const changed = await tx.inventoryHold.updateMany({
        where: { id: holdId, tenantId, status: 'HELD' },
        data: { status: expired ? 'EXPIRED' : 'RELEASED', releasedAt: new Date() },
      })
      if (changed.count === 0) return
      const nights = await tx.inventoryHoldNight.findMany({ where: { holdId, tenantId }, orderBy: { stayDate: 'asc' } })
      for (const night of nights) {
        const restored = await tx.$executeRaw(Prisma.sql`
          UPDATE "DailyAvailability"
             SET "held" = "held" - ${night.quantity}, "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${night.availabilityId} AND "tenant_id" = ${tenantId} AND "held" >= ${night.quantity}
        `)
        if (restored !== 1) throw new ConflictException('Inventory hold state is inconsistent')
      }
      await tx.auditEvent.create({ data: { tenantId, actorType: actor.type, userId: actor.type === 'USER' ? actor.userId : undefined,
        action: expired ? 'inventory.hold.expired' : 'inventory.hold.released',
        entityType: 'inventory_hold', entityId: holdId, payload: { requestId },
      } })
    })
  }

  async expireDue(tenantId: string, now = new Date()): Promise<number> {
    const due = await this.prisma.withTenant(tenantId, tx => tx.inventoryHold.findMany({
      where: { tenantId, status: 'HELD', expiresAt: { lte: now } }, select: { id: true }, orderBy: { expiresAt: 'asc' }, take: 100,
    }))
    // A deployed caller must use the governed restricted background role because
    // ordinary HTTP database roles cannot insert SYSTEM audit events.
    for (const hold of due) await this.release(tenantId, hold.id, `expiry:${hold.id}`, { type: 'SYSTEM' }, true)
    return due.length
  }

  private validate(command: AuthoritativeHoldCommand) {
    for (const value of [command.tenantId, command.userId, command.requestId, command.offerId, command.searchId,
      command.ratePlanId, command.canonicalHotelId, command.canonicalRoomTypeId, command.boardBasisId]) {
      if (!value || value.trim() !== value) throw new BadRequestException('Invalid hold command')
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(command.idempotencyKey)) throw new BadRequestException('Invalid idempotency key')
    if (!Number.isSafeInteger(command.rooms) || command.rooms < 1 || command.rooms > 8) throw new BadRequestException('Invalid room quantity')
    if (!Number.isSafeInteger(command.sellAmountMinor) || command.sellAmountMinor < 0) throw new BadRequestException('Invalid sell amount')
    assertSupportedSettlementCurrency(command.currency)
    stayDates(command.checkIn, command.checkOut)
    if (!Number.isFinite(Date.parse(command.offerExpiresAt)) || Date.parse(command.offerExpiresAt) <= Date.now()) throw new ConflictException('Offer expired')
  }

  private existing(hold: { id: string; requestFingerprint: string; status: string; expiresAt: Date; currency: string; sellAmountMinor: bigint; requestId: string }, fingerprint: string) {
    if (hold.requestFingerprint !== fingerprint) throw new ConflictException('Idempotency key conflicts with another request')
    if (hold.status !== 'HELD') throw new ConflictException('Idempotent hold is no longer active')
    return this.response(hold, 'already_held')
  }

  private response(hold: { id: string; requestId: string; expiresAt: Date; currency: string; sellAmountMinor: bigint }, status: 'held' | 'already_held'): InventoryHoldResponse {
    const amount = Number(hold.sellAmountMinor)
    if (!Number.isSafeInteger(amount)) throw new ConflictException('Hold amount cannot be represented safely')
    return { holdId: hold.id, requestId: hold.requestId, status, expiresAt: hold.expiresAt.toISOString(), currency: hold.currency, sellAmountMinor: amount }
  }
}
