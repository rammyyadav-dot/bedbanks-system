import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AMENITY_CATALOGUE, type HotelAmenitiesSave, type HotelAmenitiesSaved, type HotelAmenitiesView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { guardedRead } from '../admin-operations/operations-read'
import { idParam } from '../admin-operations/query-params'
import { normaliseAmenities } from './hotel-room-rules'
import { lockHotelSetup, setupToken, touchSetup } from './hotel-setup-shared'

const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
type Tx = Prisma.TransactionClient

/**
 * Hotel-level amenities (ADR 0021): selections from the controlled catalogue, saved as a set under the same concurrency token as the
 * Hotel Setup form, so a stale form cannot overwrite them. Room amenities are saved with the room.
 */
@Injectable()
export class HotelAmenitiesService {
  constructor(private readonly prisma: PrismaService) {}

  private async load(tx: Tx, tenantId: string, hotelIdRaw: string): Promise<HotelAmenitiesView> {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    const [profile, rows] = await Promise.all([tx.hotelProfile.findFirst({ where: { hotelId: hotel.id, tenantId }, select: { version: true } }), tx.hotelAmenity.findMany({ where: { tenantId, hotelId: hotel.id }, orderBy: { code: 'asc' } })])
    return { generatedAt: new Date().toISOString(), hotelId: hotel.id, concurrencyToken: setupToken(hotel, profile), catalogue: AMENITY_CATALOGUE.filter((a) => a.scope !== 'ROOM').map((a) => ({ code: a.code, label: a.label, scope: a.scope })), hotel: rows.map((r) => ({ code: r.code, feeType: r.feeType })) }
  }

  async get(tenantId: string, hotelId: string): Promise<HotelAmenitiesView> {
    return guardedRead(() => this.prisma.withTenant(tenantId, (tx) => this.load(tx, tenantId, hotelId)))
  }

  async save(tenantId: string, userId: string, hotelId: string, body: HotelAmenitiesSave, requestId: string | null): Promise<HotelAmenitiesSaved> {
    if (typeof body?.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    if (typeof body.expectedToken !== 'string' || !body.expectedToken) throw new BadRequestException('expectedToken is required')
    const errors: string[] = []
    const wanted = normaliseAmenities(body.amenities, 'HOTEL', errors)
    if (!wanted && errors.length === 0) errors.push('amenities: is required')
    if (errors.length) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    return this.prisma.withTenant(tenantId, async (tx) => {
      await lockHotelSetup(tx, tenantId, hotelId)
      const before = await this.load(tx, tenantId, hotelId)
      const prior = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: before.hotelId, action: 'hotel.amenities.updated', payload: { path: ['idempotencyKey'], equals: body.idempotencyKey } }, select: { payload: true } })
      if (prior) return { amenities: before, auditRequestId: String((prior.payload as { requestId?: string } | null)?.requestId ?? ''), replayed: true }
      if (body.expectedToken !== before.concurrencyToken) throw new ConflictException({ message: 'This hotel changed after you loaded it. Reload to see the latest version, then re-apply your change.', code: 'HOTEL_SETUP_STALE' })
      const list = wanted!
      await tx.hotelAmenity.deleteMany({ where: { tenantId, hotelId: before.hotelId, code: { notIn: list.map((a) => a.code) } } })
      for (const a of list) await tx.hotelAmenity.upsert({ where: { hotelId_code: { hotelId: before.hotelId, code: a.code } }, create: { tenantId, hotelId: before.hotelId, code: a.code, feeType: a.feeType, updatedById: userId }, update: { feeType: a.feeType, updatedById: userId } })
      await touchSetup(tx, tenantId, before.hotelId, userId, new Date())
      const was = new Map(before.hotel.map((a) => [a.code, a.feeType])); const now = new Map(list.map((a) => [a.code, a.feeType]))
      const added = [...now.keys()].filter((c) => !was.has(c)); const removed = [...was.keys()].filter((c) => !now.has(c)); const feeChanged = [...now.keys()].filter((c) => was.has(c) && was.get(c) !== now.get(c))
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'hotel.amenities.updated', entityType: 'hotel', entityId: before.hotelId, payload: { outcome: 'allowed', requestId, idempotencyKey: body.idempotencyKey, added, removed, feeChanged, total: list.length } as Prisma.InputJsonValue } })
      return { amenities: await this.load(tx, tenantId, hotelId), auditRequestId: requestId ?? '', replayed: false }
    })
  }
}
