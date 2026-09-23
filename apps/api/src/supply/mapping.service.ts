import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, MappingStatus } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'

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

  async hotels(tenantId: string, userId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, tx => tx.supplierHotelMapping.findMany({ where: { tenantId }, include: { supplier: true, hotel: true }, orderBy: { createdAt: 'desc' } }))
  }
  async hotel(tenantId: string, userId: string, mappingId: string) {
    await this.authorize(tenantId, userId, readPermission)
    return this.prisma.withTenant(tenantId, async tx => {
      await this.parent(tx, tenantId, mappingId)
      return tx.supplierHotelMapping.findUnique({ where: { id: mappingId }, include: { supplier: true, hotel: true } })
    })
  }
  async createHotel(tenantId: string, userId: string, input: Input, requestId?: string) {
    keys(input, ['supplierId', 'hotelId', 'supplierHotelId', 'confidence', 'sourceMetadata'], ['supplierId', 'hotelId', 'supplierHotelId'])
    const supplierId = id(input.supplierId, 'supplierId'), hotelId = id(input.hotelId, 'hotelId'), supplierHotelId = id(input.supplierHotelId, 'supplierHotelId')
    const score = confidence(input.confidence), sourceMetadata = metadata(input.sourceMetadata)
    return this.write(tenantId, userId, requestId, 'created', 'hotel', async tx => {
      const [supplier, hotel] = await Promise.all([
        tx.supplier.findFirst({ where: { id: supplierId, tenantId } }),
        tx.hotel.findFirst({ where: { id: hotelId, tenantId } }),
      ])
      if (!supplier || !hotel) throw new BadRequestException('Invalid mapping relationship')
      const value = await tx.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId, confidence: score, sourceMetadata } })
      return { id: value.id, value, payload: { supplierId, supplierHotelId, hotelId, status: value.status, confidence: score } }
    })
  }
  async updateHotel(tenantId: string, userId: string, mappingId: string, input: Input, requestId?: string) {
    keys(input, ['confidence', 'sourceMetadata']); if (!Object.keys(input).length) throw new BadRequestException('No fields to update')
    const data = { ...(input.confidence !== undefined ? { confidence: confidence(input.confidence) } : {}), ...(input.sourceMetadata !== undefined ? { sourceMetadata: metadata(input.sourceMetadata) } : {}) }
    return this.write(tenantId, userId, requestId, 'updated', 'hotel', async tx => {
      const prior = await this.parent(tx, tenantId, mappingId)
      const value = await tx.supplierHotelMapping.update({ where: { id: mappingId }, data })
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
    return this.write(tenantId, userId, requestId, 'created', 'room', async tx => {
      const parent = await this.parent(tx, tenantId, mappingId)
      const room = await tx.roomType.findFirst({ where: { id: roomTypeId, hotelId: parent.hotelId } })
      if (!room) throw new BadRequestException('Room type does not belong to mapped hotel')
      const value = await tx.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mappingId, hotelId: parent.hotelId, supplierRoomId, roomTypeId, confidence: score, sourceMetadata } })
      return { id: value.id, value, payload: { supplierId: parent.supplierId, supplierHotelId: parent.supplierHotelId, supplierRoomId, hotelId: parent.hotelId, roomTypeId, status: value.status, confidence: score } }
    })
  }
  async updateRoom(tenantId: string, userId: string, mappingId: string, roomMappingId: string, input: Input, requestId?: string) {
    keys(input, ['confidence', 'sourceMetadata']); if (!Object.keys(input).length) throw new BadRequestException('No fields to update')
    const data = { ...(input.confidence !== undefined ? { confidence: confidence(input.confidence) } : {}), ...(input.sourceMetadata !== undefined ? { sourceMetadata: metadata(input.sourceMetadata) } : {}) }
    return this.write(tenantId, userId, requestId, 'updated', 'room', async tx => {
      const parent = await this.parent(tx, tenantId, mappingId)
      const prior = await tx.supplierRoomMapping.findFirst({ where: { id: roomMappingId, tenantId, supplierHotelMappingId: mappingId } })
      if (!prior) throw new NotFoundException('Mapping not found')
      const value = await tx.supplierRoomMapping.update({ where: { id: roomMappingId }, data })
      return { id: roomMappingId, value, payload: { supplierId: parent.supplierId, supplierHotelId: parent.supplierHotelId, supplierRoomId: prior.supplierRoomId, hotelId: parent.hotelId, roomTypeId: prior.roomTypeId, previousStatus: prior.status, newStatus: value.status, confidence: value.confidence } }
    })
  }
  async decide(tenantId: string, userId: string, kind: MappingKind, mappingId: string, decision: 'approve' | 'reject' | 'reopen', requestId?: string, parentId?: string) {
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
        const approvedRooms = await tx.supplierRoomMapping.count({ where: { supplierHotelMappingId: mappingId, status: 'MAPPED' } })
        if (approvedRooms) throw new BadRequestException('Reopen approved room mappings first')
      }
      const status: MappingStatus = decision === 'approve' ? 'MAPPED' : decision === 'reject' ? 'REJECTED' : 'PENDING'
      const changed = kind === 'hotel'
        ? await tx.supplierHotelMapping.updateMany({ where: { id: mappingId, tenantId, status: prior.status }, data: { status } })
        : await tx.supplierRoomMapping.updateMany({ where: { id: mappingId, tenantId, supplierHotelMappingId: parentId, status: prior.status }, data: { status } })
      if (changed.count !== 1) throw new BadRequestException('Mapping status changed; retry the decision')
      const value = kind === 'hotel'
        ? await tx.supplierHotelMapping.findUniqueOrThrow({ where: { id: mappingId } })
        : await tx.supplierRoomMapping.findUniqueOrThrow({ where: { id: mappingId } })
      return { id: mappingId, value, payload: { supplierId: kind === 'hotel' ? (prior as { supplierId: string }).supplierId : parent!.supplierId,
        hotelId: prior.hotelId, supplierHotelId: kind === 'hotel' ? (prior as { supplierHotelId: string }).supplierHotelId : parent!.supplierHotelId,
        ...(kind === 'room' ? { supplierRoomId: (prior as { supplierRoomId: string }).supplierRoomId, roomTypeId: (prior as { roomTypeId: string }).roomTypeId } : {}),
        previousStatus: prior.status, newStatus: status, confidence: prior.confidence } }
    })
  }
}
