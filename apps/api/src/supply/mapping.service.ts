import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, MappingStatus } from '@prisma/client'
import { MAPPING_DUPLICATE_CONFLICT_CODE, type HotelMappingSuggestionQuery, type HotelMappingSuggestions } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { possibleDuplicatesFor } from '../hotel-setup/hotel-duplicate-lookup'
import { matchSupplierHotel } from '../mapping/hybrid-match'
import { retrieveHotelCandidates } from '../mapping/hotel-search-index'

type Input = Record<string, unknown>
type MappingKind = 'hotel' | 'room'
const readPermission = 'supply.mappings.read'
const managePermission = 'supply.mappings.manage'

function keys(input: Input, allowed: string[], required: string[] = []) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !(key in input))) throw new BadRequestException('Invalid mapping fields')
}
function id(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new BadRequestException(`Invalid ${field}`)
  return value
}
function confidence(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100) throw new BadRequestException('Invalid confidence')
  return value as number
}
/** An optional decision reason, recorded in the audit payload only. */
function reasonOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 500) throw new BadRequestException('reason must be 3 to 500 characters')
  return value.trim()
}
function metadata(value: unknown): Prisma.InputJsonObject {
  if (value === undefined) return {}
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new BadRequestException('Invalid sourceMetadata')
  return value as Prisma.InputJsonObject
}

@Injectable()
export class MappingService {
  constructor(private readonly prisma: PrismaService) {}

  private async authorize(tenantId: string, userId: string, permission: string) {
    const count = await this.prisma.withTenant(tenantId, tx => tx.userRole.count({ where: {
      tenantId, userId, role: { tenantId, permissions: { some: { permission: { key: permission } } } },
    } }))
    if (!count) throw new ForbiddenException('Insufficient permission')
  }

  private async write<T>(tenantId: string, userId: string, requestId: string | undefined, action: string, kind: MappingKind,
    work: (tx: Prisma.TransactionClient) => Promise<{ id: string; value: T; payload: Input }>): Promise<T> {
    await this.authorize(tenantId, userId, managePermission)
    return this.prisma.withTenant(tenantId, async tx => {
      const { id: entityId, value, payload } = await work(tx)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: `supply.${kind}_mapping.${action}`,
        entityType: `supplier_${kind}_mapping`, entityId,
        payload: { ...payload, outcome: 'allowed', requestId: requestId ?? null } as Prisma.InputJsonObject } })
      return value
    })
  }

  private async parent(tx: Prisma.TransactionClient, tenantId: string, mappingId: string) {
    const parent = await tx.supplierHotelMapping.findFirst({ where: { id: mappingId, tenantId } })
    if (!parent) throw new NotFoundException('Mapping not found')
    return parent
  }

  async options(tenantId: string, userId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async tx => ({
      suppliers: await tx.supplier.findMany({ where: { tenantId }, select: { id: true, displayName: true }, orderBy: { displayName: 'asc' } }),
      hotels: await tx.hotel.findMany({ where: { tenantId }, select: { id: true, name: true, city: true }, orderBy: { name: 'asc' } }),
    }))
  }
  async roomOptions(tenantId: string, userId: string, mappingId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async tx => {
      const parent = await this.parent(tx, tenantId, mappingId)
      return tx.roomType.findMany({ where: { hotelId: parent.hotelId, isActive: true }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } })
    })
  }

  /**
   * Advisory canonical-hotel suggestions for a supplier hotel being mapped. The tenant's HotelSearchIndex shortlists candidates
   * (vector + trigram), then the hybrid scorer ranks the shortlist. This never writes and never approves: a person still creates and
   * approves the mapping (ADR 0004). An unpopulated index is reported as `indexReady: false`, not as "no match".
   */
  async suggestHotels(tenantId: string, userId: string, query: HotelMappingSuggestionQuery): Promise<HotelMappingSuggestions> {
    await this.authorize(tenantId, userId, readPermission)
    const text = (value: unknown, field: string, required = false, max = 200) => {
      if (value === undefined || value === '') { if (required) throw new BadRequestException(`Invalid ${field}`); return undefined }
      if (typeof value !== 'string' || value.trim().length < (required ? 2 : 1) || value.length > max) throw new BadRequestException(`Invalid ${field}`)
      return value.trim()
    }
    const name = text(query?.name, 'name', true) as string
    const address = text(query?.address, 'address')
    const city = text(query?.city, 'city')
    const country = text(query?.countryCode, 'countryCode', false, 2)
    if (country !== undefined && !/^[A-Za-z]{2}$/.test(country)) throw new BadRequestException('Invalid countryCode')
    const countryCode = country?.toUpperCase()
    return this.prisma.withTenant(tenantId, async (tx) => {
      const indexed = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`SELECT 1 AS "one" FROM "HotelSearchIndex" WHERE "tenant_id" = ${tenantId} LIMIT 1`)
      if (indexed.length === 0) return { indexReady: false, suggestions: [] }
      const shortlist = await retrieveHotelCandidates(tx, tenantId, { name, address, city, countryCode })
      if (shortlist.length === 0) return { indexReady: true, suggestions: [] }
      const hotels = await tx.hotel.findMany({
        where: { tenantId, id: { in: shortlist.map((row) => row.hotelId) } },
        select: { id: true, name: true, address: true, city: true, countryCode: true, latitude: true, longitude: true },
      })
      const catalog = hotels.map((hotel) => ({ hotelId: hotel.id, name: hotel.name, address: hotel.address, city: hotel.city, countryCode: hotel.countryCode, latitude: hotel.latitude === null ? null : Number(hotel.latitude), longitude: hotel.longitude === null ? null : Number(hotel.longitude) }))
      const byId = new Map(hotels.map((hotel) => [hotel.id, hotel]))
      const suggestions = matchSupplierHotel({ supplierHotelId: 'suggestion-query', name, address, city, countryCode }, catalog).candidates
        .flatMap((candidate) => {
          const hotel = byId.get(candidate.canonicalHotelId)
          return hotel && candidate.tier !== 'NO_MATCH' ? [{ hotelId: hotel.id, name: hotel.name, city: hotel.city, countryCode: hotel.countryCode, confidence: candidate.confidenceScore, tier: candidate.tier, reasons: candidate.matchingReasons }] : []
        })
      return { indexReady: true, suggestions }
    })
  }

  async hotels(tenantId: string, userId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, tx => tx.supplierHotelMapping.findMany({ where: { tenantId }, include: { supplier: true, hotel: true }, orderBy: { createdAt: 'desc' } }))
  }
  async hotel(tenantId: string, userId: string, mappingId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async tx => {
      await this.parent(tx, tenantId, mappingId)
      return tx.supplierHotelMapping.findUnique({ where: { id: mappingId, tenantId }, include: { supplier: true, hotel: true } })
    })
  }
  /**
   * A unique-constraint failure is a mapping conflict, not a server error: it is reported as 409 with a machine-readable code and,
   * when it can be found inside this tenant, the record it collides with. A supplier hotel or room id identifies one record per supplier.
   */
  private async guardUnique<T>(tenantId: string, ctx: { supplierId?: string; supplierHotelId?: string; hotelId?: string; mappingId?: string; supplierRoomId?: string }, work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      const target = JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? '')
      if (ctx.mappingId && ctx.supplierRoomId) {
        throw new ConflictException({ message: `Supplier room id "${ctx.supplierRoomId}" is already mapped under this supplier hotel mapping.`, code: 'SUPPLIER_ROOM_ID_CONFLICT' })
      }
      if (ctx.supplierId && /hotel_id/.test(target) && !/supplier_hotel_id/.test(target)) {
        const own = await this.prisma.withTenant(tenantId, tx => tx.supplierHotelMapping.findFirst({ where: { tenantId, supplierId: ctx.supplierId, hotelId: ctx.hotelId }, select: { supplierHotelId: true, status: true } }))
        throw new ConflictException({ message: `This hotel already has a mapping from this supplier${own ? ` (supplier hotel id ${own.supplierHotelId}, ${own.status})` : ''}. Reopen or reject that mapping instead of creating another.`, code: 'SUPPLIER_ALREADY_MAPPED_TO_HOTEL' })
      }
      const other = ctx.supplierId ? await this.prisma.withTenant(tenantId, tx => tx.supplierHotelMapping.findFirst({ where: { tenantId, supplierId: ctx.supplierId, supplierHotelId: ctx.supplierHotelId }, select: { hotelId: true, status: true, hotel: { select: { name: true } } } })) : null
      throw new ConflictException({ message: `Supplier hotel id "${ctx.supplierHotelId}" is already mapped for this supplier${other ? ` to "${other.hotel.name}" (${other.hotelId}, ${other.status})` : ''}. A supplier hotel id identifies exactly one canonical hotel.`, code: 'SUPPLIER_HOTEL_ID_CONFLICT' })
    }
  }

  async createHotel(tenantId: string, userId: string, input: Input, requestId?: string) {
    keys(input, ['supplierId', 'hotelId', 'supplierHotelId', 'confidence', 'sourceMetadata'], ['supplierId', 'hotelId', 'supplierHotelId'])
    const supplierId = id(input.supplierId, 'supplierId'), hotelId = id(input.hotelId, 'hotelId'), supplierHotelId = id(input.supplierHotelId, 'supplierHotelId')
    const score = confidence(input.confidence), sourceMetadata = metadata(input.sourceMetadata)
    return this.guardUnique(tenantId, { supplierId, supplierHotelId, hotelId }, () => this.write(tenantId, userId, requestId, 'created', 'hotel', async tx => {
      const [supplier, hotel] = await Promise.all([
        tx.supplier.findFirst({ where: { id: supplierId, tenantId } }),
        tx.hotel.findFirst({ where: { id: hotelId, tenantId } }),
      ])
      if (!supplier || !hotel) throw new BadRequestException('Invalid mapping relationship')
      const value = await tx.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId, confidence: score, sourceMetadata } })
      return { id: value.id, value, payload: { supplierId, supplierHotelId, hotelId, status: value.status, confidence: score } }
    }))
  }
  async updateHotel(tenantId: string, userId: string, mappingId: string, input: Input, requestId?: string) {
    keys(input, ['confidence', 'sourceMetadata']); if (!Object.keys(input).length) throw new BadRequestException('No fields to update')
    const data = { ...(input.confidence !== undefined ? { confidence: confidence(input.confidence) } : {}), ...(input.sourceMetadata !== undefined ? { sourceMetadata: metadata(input.sourceMetadata) } : {}) }
    return this.write(tenantId, userId, requestId, 'updated', 'hotel', async tx => {
      const prior = await this.parent(tx, tenantId, mappingId)
      const value = await tx.supplierHotelMapping.update({ where: { id: mappingId, tenantId }, data })
      return { id: mappingId, value, payload: { supplierId: prior.supplierId, supplierHotelId: prior.supplierHotelId, hotelId: prior.hotelId, previousStatus: prior.status, newStatus: value.status, confidence: value.confidence } }
    })
  }
  async rooms(tenantId: string, userId: string, mappingId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async tx => {
      await this.parent(tx, tenantId, mappingId)
      return tx.supplierRoomMapping.findMany({ where: { tenantId, supplierHotelMappingId: mappingId }, include: { roomType: true }, orderBy: { createdAt: 'desc' } })
    })
  }
  async room(tenantId: string, userId: string, mappingId: string, roomMappingId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async tx => {
      await this.parent(tx, tenantId, mappingId)
      const value = await tx.supplierRoomMapping.findFirst({ where: { id: roomMappingId, tenantId, supplierHotelMappingId: mappingId }, include: { roomType: true } })
      if (!value) throw new NotFoundException('Mapping not found')
      return value
    })
  }
  async createRoom(tenantId: string, userId: string, mappingId: string, input: Input, requestId?: string) {
    keys(input, ['supplierRoomId', 'roomTypeId', 'confidence', 'sourceMetadata'], ['supplierRoomId', 'roomTypeId'])
    const supplierRoomId = id(input.supplierRoomId, 'supplierRoomId'), roomTypeId = id(input.roomTypeId, 'roomTypeId')
    const score = confidence(input.confidence), sourceMetadata = metadata(input.sourceMetadata)
    return this.guardUnique(tenantId, { mappingId, supplierRoomId }, () => this.write(tenantId, userId, requestId, 'created', 'room', async tx => {
      const parent = await this.parent(tx, tenantId, mappingId)
      const room = await tx.roomType.findFirst({ where: { id: roomTypeId, hotelId: parent.hotelId } })
      if (!room) throw new BadRequestException('Room type does not belong to mapped hotel')
      const value = await tx.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mappingId, hotelId: parent.hotelId, supplierRoomId, roomTypeId, confidence: score, sourceMetadata } })
      return { id: value.id, value, payload: { supplierId: parent.supplierId, supplierHotelId: parent.supplierHotelId, supplierRoomId, hotelId: parent.hotelId, roomTypeId, status: value.status, confidence: score } }
    }))
  }
  async updateRoom(tenantId: string, userId: string, mappingId: string, roomMappingId: string, input: Input, requestId?: string) {
    keys(input, ['confidence', 'sourceMetadata']); if (!Object.keys(input).length) throw new BadRequestException('No fields to update')
    const data = { ...(input.confidence !== undefined ? { confidence: confidence(input.confidence) } : {}), ...(input.sourceMetadata !== undefined ? { sourceMetadata: metadata(input.sourceMetadata) } : {}) }
    return this.write(tenantId, userId, requestId, 'updated', 'room', async tx => {
      const parent = await this.parent(tx, tenantId, mappingId)
      const prior = await tx.supplierRoomMapping.findFirst({ where: { id: roomMappingId, tenantId, supplierHotelMappingId: mappingId } })
      if (!prior) throw new NotFoundException('Mapping not found')
      const value = await tx.supplierRoomMapping.update({ where: { id: roomMappingId, tenantId }, data })
      return { id: roomMappingId, value, payload: { supplierId: parent.supplierId, supplierHotelId: parent.supplierHotelId, supplierRoomId: prior.supplierRoomId, hotelId: parent.hotelId, roomTypeId: prior.roomTypeId, previousStatus: prior.status, newStatus: value.status, confidence: value.confidence } }
    })
  }
  async decide(tenantId: string, userId: string, kind: MappingKind, mappingId: string, decision: 'approve' | 'reject' | 'reopen', requestId?: string, parentId?: string, reasonRaw?: unknown, acknowledgeRaw?: unknown) {
    const reason = reasonOf(reasonRaw)
    if (acknowledgeRaw !== undefined && (!Array.isArray(acknowledgeRaw) || acknowledgeRaw.length > 20 || acknowledgeRaw.some((v) => typeof v !== 'string' || !v.trim()))) throw new BadRequestException('acknowledgeDuplicateHotelIds must be a list of at most 20 hotel ids')
    const acknowledged = new Set<string>((acknowledgeRaw as string[] | undefined) ?? [])
    return this.write(tenantId, userId, requestId, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'reopened', kind, async tx => {
      // Serialize parent decisions with room approvals. A room cannot become
      // MAPPED while its Hotel mapping is concurrently reopened or rejected.
      const lockedParentId = kind === 'hotel' ? mappingId : parentId!
      await tx.$queryRaw`SELECT "id" FROM "SupplierHotelMapping" WHERE "id" = ${lockedParentId} AND "tenant_id" = ${tenantId} FOR UPDATE`
      const parent = kind === 'room' ? await this.parent(tx, tenantId, parentId!) : null
      const prior = kind === 'hotel'
        ? await this.parent(tx, tenantId, mappingId)
        : await tx.supplierRoomMapping.findFirst({ where: { id: mappingId, tenantId, supplierHotelMappingId: parentId } })
      if (!prior) throw new NotFoundException('Mapping not found')
      if ((decision === 'reopen') === (prior.status === 'PENDING')) throw new BadRequestException('Invalid mapping transition')
      if (kind === 'room' && decision === 'approve' && parent!.status !== 'MAPPED') throw new BadRequestException('Approve the hotel mapping first')
      if (kind === 'hotel' && decision !== 'approve') {
        const approvedRooms = await tx.supplierRoomMapping.count({ where: { supplierHotelMappingId: mappingId, status: 'MAPPED', tenantId } })
        if (approvedRooms) throw new BadRequestException('Reopen approved room mappings first')
      }
      // A supplier already MAPPED to a likely duplicate of this canonical hotel would sell the same inventory under two identities (ADR 0059).
      let acknowledgedDuplicates: string[] = []
      if (kind === 'hotel' && decision === 'approve') {
        const hotel = await tx.hotel.findFirstOrThrow({ where: { id: prior.hotelId, tenantId } })
        const [profile, identifiers] = await Promise.all([tx.hotelProfile.findFirst({ where: { hotelId: hotel.id, tenantId }, select: { postalCode: true } }), tx.hotelExternalIdentifier.findMany({ where: { hotelId: hotel.id, tenantId }, select: { scheme: true, value: true } })])
        const duplicates = await possibleDuplicatesFor(tx, tenantId, hotel, profile?.postalCode ?? null, identifiers)
        const conflicts = duplicates.length ? await tx.supplierHotelMapping.findMany({ where: { tenantId, supplierId: (prior as { supplierId: string }).supplierId, status: 'MAPPED', hotelId: { in: duplicates.map((d) => d.hotelId) } }, select: { hotelId: true, supplierHotelId: true } }) : []
        if (conflicts.length) {
          const missing = conflicts.filter((c) => !acknowledged.has(c.hotelId))
          if (missing.length || !reason) {
            throw new ConflictException({
              code: MAPPING_DUPLICATE_CONFLICT_CODE, message: 'This supplier is already mapped to a likely duplicate of this hotel. Resolve the duplicate, or acknowledge each listed hotel with a reason.',
              details: conflicts.map((c) => { const d = duplicates.find((x) => x.hotelId === c.hotelId)!; return { hotelId: c.hotelId, name: d.name, city: d.city, supplierHotelId: c.supplierHotelId, basis: d.basis } }),
            })
          }
          acknowledgedDuplicates = conflicts.map((c) => c.hotelId).sort()
        }
      }
      const status: MappingStatus = decision === 'approve' ? 'MAPPED' : decision === 'reject' ? 'REJECTED' : 'PENDING'
      const changed = kind === 'hotel'
        ? await tx.supplierHotelMapping.updateMany({ where: { id: mappingId, tenantId, status: prior.status }, data: { status } })
        : await tx.supplierRoomMapping.updateMany({ where: { id: mappingId, tenantId, supplierHotelMappingId: parentId, status: prior.status }, data: { status } })
      if (changed.count !== 1) throw new BadRequestException('Mapping status changed; retry the decision')
      const value = kind === 'hotel'
        ? await tx.supplierHotelMapping.findUniqueOrThrow({ where: { id: mappingId, tenantId } })
        : await tx.supplierRoomMapping.findUniqueOrThrow({ where: { id: mappingId, tenantId } })
      return { id: mappingId, value, payload: { supplierId: kind === 'hotel' ? (prior as { supplierId: string }).supplierId : parent!.supplierId,
        hotelId: prior.hotelId, supplierHotelId: kind === 'hotel' ? (prior as { supplierHotelId: string }).supplierHotelId : parent!.supplierHotelId,
        ...(kind === 'room' ? { supplierRoomId: (prior as { supplierRoomId: string }).supplierRoomId, roomTypeId: (prior as { roomTypeId: string }).roomTypeId } : {}),
        previousStatus: prior.status, newStatus: status, confidence: prior.confidence, ...(reason ? { reason } : {}), ...(acknowledgedDuplicates.length ? { acknowledgedDuplicateHotelIds: acknowledgedDuplicates } : {}) } }
    })
  }
}
