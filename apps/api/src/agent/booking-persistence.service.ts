import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BookingTransactionCommand } from '@bedbanks/domain'
import { createHash } from 'crypto'
import { PrismaService } from '../database/prisma.service'
import { freezeCancellationTerms } from './booking-cancellation-terms'
import { rulesForPlan } from '../supply/cancellation-rules'
import { readSupplierPrebook, type RecordedSupplierPrebook } from './supplier-prebook-record'

const COMMERCIAL_SNAPSHOT_KEYS = [
  'version', 'requestId', 'offerId', 'searchId', 'inventoryHoldId', 'canonicalHotelId', 'canonicalRoomTypeId',
  'ratePlanId', 'boardBasisId', 'checkIn', 'checkOut', 'rooms', 'adults', 'children', 'childAges',
  'currency', 'totalMinor', 'leadGuest',
] as const

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) => `${key}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameCommercialSnapshot(stored: Prisma.JsonValue, expected: Prisma.InputJsonObject): boolean {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false
  const left = stored as Record<string, unknown>
  return COMMERCIAL_SNAPSHOT_KEYS.every((key) => stable(left[key]) === stable(expected[key]))
}

type BookingRecord = {
  id: string
  tenantId: string
  reference: string
  supplier: string
  hotelId: string
  status: string
  currency: string
  totalMinor: bigint
  idempotencyKey: string
  searchSnapshot: Prisma.JsonValue
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function immutableSnapshot(command: BookingTransactionCommand): Prisma.InputJsonObject {
  return {
    version: 1,
    requestId: command.requestId,
    offerId: command.offerId,
    searchId: command.searchId,
    inventoryHoldId: command.inventoryHoldId,
    canonicalHotelId: command.canonicalHotelId,
    canonicalRoomTypeId: command.canonicalRoomTypeId,
    ratePlanId: command.ratePlanId,
    boardBasisId: command.boardBasisId,
    checkIn: command.checkIn,
    checkOut: command.checkOut,
    rooms: command.rooms,
    adults: command.adults,
    children: command.children,
    childAges: command.childAges,
    currency: command.currency,
    totalMinor: command.totalMinor,
    leadGuest: command.leadGuest,
  }
}

function bookingReference(command: BookingTransactionCommand): string {
  return `FB-${createHash('sha256').update(`${command.tenantId}:${command.idempotencyKey}`).digest('hex').slice(0, 20).toUpperCase()}`
}

@Injectable()
export class BookingPersistenceService {
  constructor(private readonly prisma: PrismaService) {}

  async persistPending(command: BookingTransactionCommand): Promise<BookingRecord> {
    const snapshot = immutableSnapshot(command)
    const key = { tenantId_idempotencyKey: { tenantId: command.tenantId, idempotencyKey: command.idempotencyKey } }

    try {
      return await this.prisma.withTenant(command.tenantId, async tx => {
        const existing = await tx.booking.findUnique({ where: key })
        if (existing) return this.existing(existing, command, snapshot)

        const hold = await tx.inventoryHold.findFirst({ where: { id: command.inventoryHoldId, tenantId: command.tenantId } })
        if (!hold) throw new ForbiddenException('Inventory hold is unavailable')
        this.assertAuthoritativeHold(hold, command)

        // Supplier ownership (ADR 0061 Amendment 1): frozen here, once, from the hold's rate plan -> contract -> supplier, all inside this tenant.
        // Never from `Booking.supplier`, a name, the snapshot or any request field. A hold whose plan or contract cannot be resolved fails closed.
        const plan = await tx.ratePlan.findFirst({ where: { id: hold.ratePlanId, tenantId: command.tenantId }, select: { contract: { select: { tenantId: true, supplierId: true } } } })
        if (!plan || plan.contract.tenantId !== command.tenantId || !plan.contract.supplierId) throw new ForbiddenException('Inventory hold is unavailable')
        const supplierId = plan.contract.supplierId

        // The Admin booking module's promoted columns and child rows (ADR 0039): written in this same transaction from the same command,
        // so the list never has to guess from the JSON snapshot. The agency is the booking user's agency membership, or null (Unassigned).
        const member = await tx.agencyMember.findUnique({ where: { tenantId_userId: { tenantId: command.tenantId, userId: command.userId } }, select: { agencyId: true } })
        const checkIn = new Date(`${command.checkIn}T00:00:00.000Z`)
        const checkOut = new Date(`${command.checkOut}T00:00:00.000Z`)
        // Finding F13: the terms the buyer was shown are frozen onto the booking, so a later contract edit cannot change a cancellation or a voucher.
        const plan = await tx.ratePlan.findFirst({ where: { id: command.ratePlanId, tenantId: command.tenantId }, include: { contract: { include: { cancellationPolicies: true } } } })
        if (!plan) throw new ConflictException('Rate plan is unavailable')
        const resolved = rulesForPlan(plan, plan.contract.cancellationPolicies)
        if (resolved.missing) throw new ConflictException('The rate plan names a cancellation rule set that has no rules')
        const frozenTerms = freezeCancellationTerms(resolved.rules, command.currency, resolved.set, new Date())
        if (frozenTerms === null) throw new ConflictException('The cancellation terms of this rate plan cannot be recorded on the booking')
        const created = await tx.booking.create({
          data: {
            cancellationPolicy: frozenTerms as Prisma.InputJsonObject,
            tenantId: command.tenantId,
            reference: bookingReference(command),
            supplier: 'PENDING_SUPPLIER',
            supplierId,
            hotelId: command.canonicalHotelId,
            status: 'PENDING_SUPPLIER',
            currency: command.currency,
            totalMinor: BigInt(command.totalMinor),
            idempotencyKey: command.idempotencyKey,
            searchSnapshot: snapshot,
            channel: 'PORTAL',
            agencyId: member?.agencyId ?? null,
            agentUserId: command.userId,
            agentRef: command.agencyReference?.trim().slice(0, 120) || null,
            checkIn, checkOut, nights: Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000),
          },
        })
        const [room, board] = await Promise.all([
          tx.roomType.findFirst({ where: { id: command.canonicalRoomTypeId, hotelId: command.canonicalHotelId, hotel: { tenantId: command.tenantId } }, select: { name: true } }),
          tx.boardBasis.findFirst({ where: { id: command.boardBasisId, tenantId: command.tenantId }, select: { code: true } }),
        ])
        const bookingRoom = await tx.bookingRoom.create({
          data: {
            tenantId: command.tenantId, bookingId: created.id, position: 1, quantity: command.rooms, roomTypeId: command.canonicalRoomTypeId, roomName: room?.name ?? null, boardCode: board?.code?.trim() ?? null,
            adults: command.adults, children: command.children, childAges: command.childAges, sellMinor: BigInt(command.totalMinor),
          },
        })
        await tx.bookingGuest.create({ data: { tenantId: command.tenantId, bookingId: created.id, roomId: bookingRoom.id, firstName: command.leadGuest.firstName, lastName: command.leadGuest.lastName, isLead: true, type: 'ADULT' } })
        await tx.bookingEvent.create({ data: { tenantId: command.tenantId, bookingId: created.id, fromStatus: null, toStatus: 'PENDING_SUPPLIER', actorType: 'USER', actorId: command.userId, reason: 'Booking created', payload: { requestId: command.requestId } } })
        return created
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error

      return this.prisma.withTenant(command.tenantId, async tx => {
        const raced = await tx.booking.findUnique({ where: key })
        if (!raced) throw error
        return this.existing(raced, command, snapshot)
      })
    }
  }

  /**
   * Records the supplier prebook result on the pending booking without changing the commercial snapshot
   * used for idempotency. Unknown is retained; a later prebooked proof may upgrade it. A recorded
   * prebook is never downgraded to unknown.
   */
  async recordSupplierPrebook(tenantId: string, bookingId: string, record: RecordedSupplierPrebook): Promise<void> {
    await this.prisma.withTenant(tenantId, async tx => {
      const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId } })
      if (!booking || booking.status !== 'PENDING_SUPPLIER') throw new ConflictException('Booking is not pending')
      const snapshot = booking.searchSnapshot
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new ConflictException('Booking snapshot is invalid')
      const prior = readSupplierPrebook(snapshot)
      if (prior?.outcome === 'prebooked' && record.outcome === 'unknown') throw new ConflictException('Supplier prebook is already recorded')
      if (prior?.supplierReference && record.supplierReference && prior.supplierReference !== record.supplierReference) {
        throw new ConflictException('Supplier reference does not match')
      }
      if (prior && prior.outcome === record.outcome && prior.supplierReference === record.supplierReference && prior.code === record.code) return
      const supplierPrebook = {
        outcome: record.outcome,
        ...(record.supplierReference ? { supplierReference: record.supplierReference } : {}),
        ...(record.code ? { code: record.code } : {}),
      }
      await tx.booking.update({
        where: { id: bookingId },
        data: { searchSnapshot: { ...(snapshot as Prisma.JsonObject), supplierPrebook } },
      })
    })
  }

  private assertAuthoritativeHold(hold: {
    status: string
    expiresAt: Date
    offerId: string
    searchId: string
    ratePlanId: string
    canonicalHotelId: string
    canonicalRoomTypeId: string
    boardBasisId: string
    checkIn: Date
    checkOut: Date
    rooms: number
    currency: string
    sellAmountMinor: bigint
  }, command: BookingTransactionCommand): void {
    if (hold.status !== 'HELD') throw new ConflictException('Inventory hold is not active')
    if (hold.expiresAt.getTime() <= Date.now()) throw new ConflictException('Inventory hold has expired')

    if (
      hold.offerId !== command.offerId ||
      hold.searchId !== command.searchId ||
      hold.ratePlanId !== command.ratePlanId ||
      hold.canonicalHotelId !== command.canonicalHotelId ||
      hold.canonicalRoomTypeId !== command.canonicalRoomTypeId ||
      hold.boardBasisId !== command.boardBasisId ||
      dateOnly(hold.checkIn) !== command.checkIn ||
      dateOnly(hold.checkOut) !== command.checkOut ||
      hold.rooms !== command.rooms ||
      hold.currency !== command.currency ||
      hold.sellAmountMinor !== BigInt(command.totalMinor)
    ) {
      throw new ConflictException('Booking intent does not match authoritative inventory hold')
    }
  }

  private existing(existing: BookingRecord, command: BookingTransactionCommand, snapshot: Prisma.InputJsonObject): BookingRecord {
    if (
      existing.tenantId !== command.tenantId ||
      existing.hotelId !== command.canonicalHotelId ||
      existing.currency !== command.currency ||
      existing.totalMinor !== BigInt(command.totalMinor) ||
      existing.status !== 'PENDING_SUPPLIER' ||
      !sameCommercialSnapshot(existing.searchSnapshot, snapshot)
    ) {
      throw new ConflictException('Booking idempotency key was reused with different booking intent')
    }
    return existing
  }
}
