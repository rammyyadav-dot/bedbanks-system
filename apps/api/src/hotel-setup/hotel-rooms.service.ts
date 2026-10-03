import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { HotelChildPolicyRow, HotelRoomView, HotelRoomsView, RoomArchive, RoomSave, RoomSaved } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import { idParam } from '../admin-operations/query-params'
import { mergedOccupancyProblems, mergeBedding, normaliseRoomSave, parseBedding } from './hotel-room-rules'

const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
type Tx = Prisma.TransactionClient
type RoomRow = NonNullable<Awaited<ReturnType<Tx['roomType']['findFirst']>>>

/**
 * Canonical room management for the Hotel Setup module (ADR 0021): create, edit and archive rooms with optimistic concurrency,
 * idempotent requests and audit. Rooms are never deleted: archiving sets `isActive` false and leaves rate plans, mappings and
 * history untouched. Child-age rules are contract policies and are only read here.
 */
@Injectable()
export class HotelRoomsService {
  constructor(private readonly prisma: PrismaService) {}

  private key(value: unknown): string {
    if (typeof value !== 'string' || !KEY.test(value)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    return value
  }
  private token(room: Pick<RoomRow, 'updatedAt'>): string { return String(room.updatedAt.getTime()) }
  private stale(): never { throw new ConflictException({ message: 'This room changed after you loaded it. Reload to see the latest version, then re-apply your change.', code: 'ROOM_STALE' }) }

  private async hotel(tx: Tx, tenantId: string, hotelIdRaw: string) {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true, contentStatus: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel
  }

  private async amenitiesFor(tx: Tx, tenantId: string, roomIds: string[]): Promise<Map<string, Array<{ code: string; feeType: 'FREE' | 'PAID' | 'UNKNOWN' }>> | null> {
    if (roomIds.length === 0) return new Map()
    await tx.$executeRawUnsafe('SAVEPOINT room_amenity_read')
    try {
      const rows = await tx.roomAmenity.findMany({ where: { tenantId, roomTypeId: { in: roomIds } }, orderBy: { code: 'asc' } })
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT room_amenity_read')
      const out = new Map<string, Array<{ code: string; feeType: 'FREE' | 'PAID' | 'UNKNOWN' }>>()
      for (const r of rows) { const list = out.get(r.roomTypeId) ?? []; list.push({ code: r.code, feeType: r.feeType }); out.set(r.roomTypeId, list) }
      return out
    } catch (error) {
      if (!isBookingReadDenied(error)) throw error
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT room_amenity_read')
      return null
    }
  }

  private async usage(tx: Tx, tenantId: string, roomIds: string[]) {
    if (roomIds.length === 0) return new Map<string, HotelRoomView['usage']>()
    const [plans, maps] = await Promise.all([
      tx.ratePlan.groupBy({ by: ['roomTypeId', 'status'], where: { tenantId, roomTypeId: { in: roomIds } }, _count: { _all: true } }),
      tx.supplierRoomMapping.groupBy({ by: ['roomTypeId', 'status'], where: { tenantId, roomTypeId: { in: roomIds } }, _count: { _all: true } }),
    ])
    const out = new Map<string, HotelRoomView['usage']>(roomIds.map((id) => [id, { ratePlans: 0, activeRatePlans: 0, mappings: { mapped: 0, pending: 0, rejected: 0 } }]))
    for (const p of plans) { const u = out.get(p.roomTypeId)!; u.ratePlans += p._count._all; if (p.status === 'ACTIVE') u.activeRatePlans += p._count._all }
    for (const m of maps) { const u = out.get(m.roomTypeId)!; if (m.status === 'MAPPED') u.mappings.mapped += m._count._all; else if (m.status === 'REJECTED') u.mappings.rejected += m._count._all; else u.mappings.pending += m._count._all }
    return out
  }

  private view(r: RoomRow, usage: HotelRoomView['usage'], amenities: HotelRoomView['amenities']): HotelRoomView {
    return { id: r.id, code: r.code, name: r.name, maxAdults: r.maxAdults, maxChildren: r.maxChildren, maxOccupancy: r.maxOccupancy, isActive: r.isActive, bedding: parseBedding(r.beddingMetadata), amenities, usage, concurrencyToken: this.token(r), updatedAt: r.updatedAt.toISOString() }
  }

  private async one(tx: Tx, tenantId: string, hotelId: string, roomId: string): Promise<HotelRoomView> {
    const room = await tx.roomType.findFirst({ where: { id: roomId, hotelId, hotel: { tenantId } } })
    if (!room) throw new NotFoundException('Room not found')
    const [usage, amenities] = await Promise.all([this.usage(tx, tenantId, [room.id]), this.amenitiesFor(tx, tenantId, [room.id])])
    return this.view(room, usage.get(room.id)!, amenities ? amenities.get(room.id) ?? [] : null)
  }

  async list(tenantId: string, hotelIdRaw: string): Promise<HotelRoomsView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const rooms = await tx.roomType.findMany({ where: { hotelId: hotel.id }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }] })
      const ids = rooms.map((r) => r.id)
      // Savepoints nest on the transaction's single connection, so the two guarded reads run one after the other, never concurrently.
      const usage = await this.usage(tx, tenantId, ids)
      const amenities = await this.amenitiesFor(tx, tenantId, ids)
      const childPolicies = await this.childPolicies(tx, tenantId, hotel.id)
      return { generatedAt: new Date().toISOString(), hotelId: hotel.id, hotelStatus: hotel.contentStatus, rooms: rooms.map((r) => this.view(r, usage.get(r.id)!, amenities ? amenities.get(r.id) ?? [] : null)), childPolicies, amenitiesAvailable: amenities !== null }
    })
  }

  private async childPolicies(tx: Tx, tenantId: string, hotelId: string): Promise<HotelChildPolicyRow[] | null> {
    await tx.$executeRawUnsafe('SAVEPOINT child_policy_read')
    try {
      const rows = await tx.childPolicy.findMany({
        where: { contract: { tenantId, OR: [{ supplierHotelMapping: { is: { hotelId } } }, { ratePlans: { some: { roomType: { hotelId } } } }] } },
        include: { contract: { select: { id: true, code: true, supplier: { select: { displayName: true } } } } },
        orderBy: [{ contractId: 'asc' }, { minAge: 'asc' }], take: 200,
      })
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT child_policy_read')
      return rows.map((p) => ({ contractId: p.contract.id, contractCode: p.contract.code, supplierName: p.contract.supplier.displayName, minAge: p.minAge, maxAge: p.maxAge, extraBedAllowed: p.extraBedAllowed, supplementMinor: p.supplementMinor === null ? null : p.supplementMinor.toString(), currency: p.currency }))
    } catch (error) {
      if (!isBookingReadDenied(error)) throw error
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT child_policy_read')
      return null
    }
  }

  private async replay(tx: Tx, tenantId: string, entityId: string, action: string, key: string): Promise<{ requestId: string } | null> {
    const found = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'room_type', entityId, action, payload: { path: ['idempotencyKey'], equals: key } }, select: { payload: true } })
    return found ? { requestId: String((found.payload as { requestId?: string } | null)?.requestId ?? '') } : null
  }

  private async setAmenities(tx: Tx, tenantId: string, hotelId: string, roomId: string, userId: string, wanted: Array<{ code: string; feeType: 'FREE' | 'PAID' | 'UNKNOWN' }>) {
    await tx.roomAmenity.deleteMany({ where: { tenantId, roomTypeId: roomId, code: { notIn: wanted.map((w) => w.code) } } })
    for (const w of wanted) await tx.roomAmenity.upsert({ where: { roomTypeId_code: { roomTypeId: roomId, code: w.code } }, create: { tenantId, hotelId, roomTypeId: roomId, code: w.code, feeType: w.feeType, updatedById: userId }, update: { feeType: w.feeType, updatedById: userId } })
  }

  async create(tenantId: string, userId: string, hotelIdRaw: string, body: RoomSave, requestId: string | null): Promise<RoomSaved> {
    const key = this.key(body?.idempotencyKey)
    const { data, errors } = normaliseRoomSave(body, 'create')
    errors.push(...mergedOccupancyProblems({ maxAdults: 1, maxChildren: 0, maxOccupancy: 1 }, data.fields).filter((e) => !errors.some((x) => x.startsWith(e.split(':')[0]))))
    if (errors.length) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
        const prior = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'room_type', action: 'hotel.room.created', payload: { path: ['idempotencyKey'], equals: key } }, select: { entityId: true, payload: true } })
        if (prior) return { room: await this.one(tx, tenantId, hotel.id, prior.entityId), auditRequestId: String((prior.payload as { requestId?: string } | null)?.requestId ?? ''), replayed: true }
        const f = data.fields
        const room = await tx.roomType.create({ data: { hotelId: hotel.id, name: f.name!, code: f.code!, maxAdults: f.maxAdults!, maxChildren: f.maxChildren ?? 0, maxOccupancy: f.maxOccupancy!, beddingMetadata: mergeBedding({}, data.bedding ?? {}) as Prisma.InputJsonValue, isActive: true } })
        if (data.amenities) await this.setAmenities(tx, tenantId, hotel.id, room.id, userId, data.amenities)
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'hotel.room.created', entityType: 'room_type', entityId: room.id, payload: { outcome: 'allowed', requestId, idempotencyKey: key, hotelId: hotel.id, reason: typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null, fields: data.changed, code: room.code } as Prisma.InputJsonValue } })
        return { room: await this.one(tx, tenantId, hotel.id, room.id), auditRequestId: requestId ?? '', replayed: false }
      })
    } catch (error) { this.mapUnique(error); throw error }
  }

  private mapUnique(error: unknown): void {
    if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ message: 'A room with this code already exists in this hotel.', code: 'ROOM_CODE_CONFLICT' })
  }

  async update(tenantId: string, userId: string, hotelIdRaw: string, roomIdRaw: string, body: RoomSave, requestId: string | null): Promise<RoomSaved> {
    const key = this.key(body?.idempotencyKey)
    if (typeof body.expectedToken !== 'string' || !body.expectedToken) throw new BadRequestException('expectedToken is required')
    const roomId = idParam('roomId', roomIdRaw)
    if (!roomId) throw new BadRequestException('Invalid roomId')
    const { data, errors } = normaliseRoomSave(body, 'update')
    if (data.changed.length === 0 && errors.length === 0) throw new BadRequestException('Nothing to save: no field was supplied')
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
        const current = await tx.roomType.findFirst({ where: { id: roomId, hotelId: hotel.id } })
        if (!current) throw new NotFoundException('Room not found')
        const problems = [...errors, ...mergedOccupancyProblems(current, data.fields).filter((e) => !errors.some((x) => x.startsWith(e.split(':')[0])))]
        if (problems.length) throw new BadRequestException({ message: problems, error: 'Bad Request' })
        const again = await this.replay(tx, tenantId, current.id, 'hotel.room.updated', key)
        if (again) return { room: await this.one(tx, tenantId, hotel.id, current.id), auditRequestId: again.requestId, replayed: true }
        if (body.expectedToken !== this.token(current)) this.stale()
        const f = data.fields
        const bedding = data.bedding ? mergeBedding(current.beddingMetadata, data.bedding) : undefined
        await tx.roomType.update({ where: { id: current.id }, data: { ...f, ...(bedding ? { beddingMetadata: bedding as Prisma.InputJsonValue } : {}), updatedAt: new Date() } })
        if (data.amenities) await this.setAmenities(tx, tenantId, hotel.id, current.id, userId, data.amenities)
        const SAFE = ['name', 'code', 'maxAdults', 'maxChildren', 'maxOccupancy'] as const
        const changes = Object.fromEntries(SAFE.filter((k) => f[k] !== undefined && f[k] !== current[k]).map((k) => [k, { from: current[k], to: f[k] }]))
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'hotel.room.updated', entityType: 'room_type', entityId: current.id, payload: { outcome: 'allowed', requestId, idempotencyKey: key, hotelId: hotel.id, reason: typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null, fields: data.changed, changes } as Prisma.InputJsonValue } })
        return { room: await this.one(tx, tenantId, hotel.id, current.id), auditRequestId: requestId ?? '', replayed: false }
      })
    } catch (error) { this.mapUnique(error); throw error }
  }

  /** Archive or restore. Archiving never deletes: rate plans, mappings and history stay, and the audit records what it affected. */
  async setActive(tenantId: string, userId: string, hotelIdRaw: string, roomIdRaw: string, active: boolean, body: RoomArchive, requestId: string | null): Promise<RoomSaved> {
    const key = this.key(body?.idempotencyKey)
    if (typeof body.expectedToken !== 'string' || !body.expectedToken) throw new BadRequestException('expectedToken is required')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3 || reason.length > 500) throw new BadRequestException('A reason of 3 to 500 characters is required')
    const roomId = idParam('roomId', roomIdRaw)
    if (!roomId) throw new BadRequestException('Invalid roomId')
    const action = active ? 'hotel.room.restored' : 'hotel.room.archived'
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const current = await tx.roomType.findFirst({ where: { id: roomId, hotelId: hotel.id } })
      if (!current) throw new NotFoundException('Room not found')
      const again = await this.replay(tx, tenantId, current.id, action, key)
      if (again) return { room: await this.one(tx, tenantId, hotel.id, current.id), auditRequestId: again.requestId, replayed: true }
      if (body.expectedToken !== this.token(current)) this.stale()
      if (current.isActive === active) throw new ConflictException(active ? 'The room is already active' : 'The room is already archived')
      if (!active && hotel.contentStatus === 'COMPLETE' && (await tx.roomType.count({ where: { hotelId: hotel.id, isActive: true, id: { not: current.id } } })) === 0) {
        throw new UnprocessableEntityException({ message: 'A published hotel needs at least one active room. Change the hotel status first.', code: 'HOTEL_PUBLICATION_REQUIREMENT_LOST' })
      }
      const usage = (await this.usage(tx, tenantId, [current.id])).get(current.id)!
      await tx.roomType.update({ where: { id: current.id }, data: { isActive: active, updatedAt: new Date() } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action, entityType: 'room_type', entityId: current.id, payload: { outcome: 'allowed', requestId, idempotencyKey: key, hotelId: hotel.id, reason, activeRatePlans: usage.activeRatePlans, ratePlans: usage.ratePlans, mappings: usage.mappings } as Prisma.InputJsonValue } })
      return { room: await this.one(tx, tenantId, hotel.id, current.id), auditRequestId: requestId ?? '', replayed: false }
    })
  }
}
