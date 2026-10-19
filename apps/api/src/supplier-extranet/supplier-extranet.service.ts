import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { ExtranetContractList, ExtranetHotelList } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { decodePageCursor, encodePageCursor } from './supplier-page-cursor'
import type { PageQueryDto } from './page-query.dto'

const DEFAULT_PAGE = 25
const PLANS_PER_CONTRACT = 200
const VISIBLE_MAPPING = ['PENDING', 'MAPPED'] as const
const EXTRANET_PERMISSIONS = [
  'supplier.extranet.hotels.read',
  'supplier.extranet.rooms.read',
  'supplier.extranet.drafts.manage',
  'supplier.extranet.contracts.read',
  'supplier.extranet.bookings.read',
  'supplier.extranet.bookings.answer',
  'supplier.extranet.changes.read',
  'supplier.extranet.changes.author',
] as const

const hotelFields = {
  id: true,
  name: true,
  city: true,
  countryCode: true,
  propertyType: true,
  contentStatus: true,
} as const

@Injectable()
export class SupplierExtranetService {
  constructor(private readonly prisma: PrismaService) {}

  private async permissionKeys(tenantId: string, userId: string): Promise<Set<string>> {
    const assignments = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({
      where: { tenantId, userId, role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }))
    return new Set(assignments.flatMap((assignment) => assignment.role.permissions.map((item) => item.permission.key)))
  }

  async requirePermission(tenantId: string, userId: string, permission: string): Promise<void> {
    const keys = await this.permissionKeys(tenantId, userId)
    if (!keys.has(permission)) throw new ForbiddenException('Access denied')
  }

  async memberships(tenantId: string, userId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.supplierMembership.findMany({
      where: {
        tenantId,
        userId,
        status: 'ACTIVE',
        supplier: { tenantId, status: { in: ['DRAFT', 'PENDING_REVIEW', 'ACTIVE'] } },
      },
      orderBy: { supplier: { displayName: 'asc' } },
      select: {
        supplierId: true,
        status: true,
        supplier: { select: { displayName: true, type: true, status: true, defaultCurrency: true } },
      },
    }))
    return {
      organizations: rows.map((row) => ({
        supplierId: row.supplierId,
        membershipStatus: row.status,
        displayName: row.supplier.displayName,
        type: row.supplier.type,
        supplierStatus: row.supplier.status,
        defaultCurrency: row.supplier.defaultCurrency.trim(),
      })),
    }
  }

  async context(tenantId: string, userId: string, supplierId: string) {
    const [membership, keys] = await Promise.all([
      this.prisma.withSupplier(tenantId, supplierId, (tx) => tx.supplierMembership.findFirst({
        where: { tenantId, userId, supplierId, status: 'ACTIVE' },
        select: {
          supplier: { select: { id: true, displayName: true, type: true, status: true, defaultCurrency: true } },
        },
      })),
      this.permissionKeys(tenantId, userId),
    ])
    if (!membership) throw new ForbiddenException('Access denied')
    return {
      organization: {
        supplierId: membership.supplier.id,
        displayName: membership.supplier.displayName,
        type: membership.supplier.type,
        supplierStatus: membership.supplier.status,
        defaultCurrency: membership.supplier.defaultCurrency.trim(),
      },
      permissions: EXTRANET_PERMISSIONS.filter((key) => keys.has(key)),
    }
  }

  /** Keyset-paged on (hotel name, hotel id). The cursor carries only those two keys; scope always comes from the authenticated organization. */
  async hotels(tenantId: string, userId: string, supplierId: string, query: PageQueryDto = {}): Promise<ExtranetHotelList> {
    await this.requirePermission(tenantId, userId, 'supplier.extranet.hotels.read')
    const limit = query.limit ?? DEFAULT_PAGE
    const after = query.cursor ? decodePageCursor(query.cursor, 2) : undefined
    const mappings = await this.prisma.withSupplier(tenantId, supplierId, (tx) => tx.supplierHotelMapping.findMany({
      where: {
        tenantId, supplierId, status: { in: [...VISIBLE_MAPPING] },
        ...(after ? { OR: [{ hotel: { name: { gt: after[0] } } }, { hotel: { name: after[0] }, hotelId: { gt: after[1] } }] } : {}),
      },
      orderBy: [{ hotel: { name: 'asc' } }, { hotelId: 'asc' }],
      take: limit + 1,
      select: { status: true, hotelId: true, hotel: { select: hotelFields } },
    }))
    const page = mappings.slice(0, limit)
    const last = page[page.length - 1]
    return {
      hotels: page.map((mapping) => ({
        ...mapping.hotel,
        countryCode: mapping.hotel.countryCode.trim(),
        mappingStatus: mapping.status,
      })),
      nextCursor: mappings.length > limit && last ? encodePageCursor([last.hotel.name, last.hotelId]) : null,
    }
  }

  async hotel(tenantId: string, userId: string, supplierId: string, hotelId: string) {
    await this.requirePermission(tenantId, userId, 'supplier.extranet.hotels.read')
    const mapping = await this.prisma.withSupplier(tenantId, supplierId, (tx) => tx.supplierHotelMapping.findFirst({
      where: { tenantId, supplierId, hotelId, status: { in: [...VISIBLE_MAPPING] } },
      select: { status: true, hotel: { select: hotelFields } },
    }))
    if (!mapping) throw new NotFoundException('Hotel not found')
    return { ...mapping.hotel, countryCode: mapping.hotel.countryCode.trim(), mappingStatus: mapping.status }
  }

  async rooms(tenantId: string, userId: string, supplierId: string, hotelId: string) {
    await this.requirePermission(tenantId, userId, 'supplier.extranet.rooms.read')
    return this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const mapping = await tx.supplierHotelMapping.findFirst({
        where: { tenantId, supplierId, hotelId, status: { in: [...VISIBLE_MAPPING] } },
        select: { hotel: { select: { id: true, name: true } } },
      })
      if (!mapping) throw new NotFoundException('Hotel not found')
      const rooms = await tx.roomType.findMany({
        where: { hotelId: mapping.hotel.id },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, code: true, maxAdults: true, maxChildren: true, maxOccupancy: true },
      })
      const drafts = await tx.supplierRoomDraft.findMany({
        where: { tenantId, supplierId, hotelId: mapping.hotel.id, roomTypeId: { in: rooms.map((room) => room.id) } },
        select: { roomTypeId: true, supplierNotes: true, updatedAt: true },
      })
      const notes = new Map(drafts.map((draft) => [draft.roomTypeId, draft]))
      return {
        hotelId: mapping.hotel.id,
        hotelName: mapping.hotel.name,
        rooms: rooms.map((room) => {
          const draft = notes.get(room.id)
          return {
            ...room,
            draft: draft ? { supplierNotes: draft.supplierNotes, updatedAt: draft.updatedAt.toISOString() } : null,
          }
        }),
      }
    })
  }

  /**
   * Read-only contract and rate-plan summaries for the caller's organization. Scope is the contract's own supplier id plus the
   * tenant; a contract linked to a mapping that is REJECTED is hidden. Amounts are never returned in this slice.
   */
  async contracts(tenantId: string, userId: string, supplierId: string, query: PageQueryDto = {}): Promise<ExtranetContractList> {
    await this.requirePermission(tenantId, userId, 'supplier.extranet.contracts.read')
    const limit = query.limit ?? DEFAULT_PAGE
    const after = query.cursor ? decodePageCursor(query.cursor, 3) : undefined
    const afterFrom = after ? new Date(`${after[0]}T00:00:00.000Z`) : undefined
    if (after && (Number.isNaN(afterFrom!.getTime()) || afterFrom!.toISOString().slice(0, 10) !== after[0])) throw new BadRequestException('Invalid cursor')
    const rows = await this.prisma.withSupplier(tenantId, supplierId, (tx) => tx.contract.findMany({
      where: {
        tenantId,
        supplierId,
        AND: [
          { OR: [{ supplierHotelMappingId: null }, { supplierHotelMapping: { status: { in: [...VISIBLE_MAPPING] } } }] },
          ...(after && afterFrom ? [{ OR: [{ validFrom: { lt: afterFrom } }, { validFrom: afterFrom, code: { gt: after[1] } }, { validFrom: afterFrom, code: after[1], id: { gt: after[2] } }] }] : []),
        ],
      },
      orderBy: [{ validFrom: 'desc' }, { code: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: {
        id: true, code: true, status: true, validFrom: true, validTo: true, settlementCurrency: true,
        supplierHotelMapping: { select: { hotel: { select: { id: true, name: true } } } },
        _count: { select: { ratePlans: { where: { tenantId } } } },
        ratePlans: {
          where: { tenantId },
          orderBy: { code: 'asc' },
          take: PLANS_PER_CONTRACT,
          select: {
            id: true, code: true, status: true, refundable: true, occupancy: true, currency: true, validFrom: true, validTo: true,
            roomType: { select: { name: true } },
            boardBasis: { select: { name: true } },
          },
        },
      },
    }))
    const pageRows = rows.slice(0, limit)
    const lastRow = pageRows[pageRows.length - 1]
    const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)
    return {
      nextCursor: rows.length > limit && lastRow ? encodePageCursor([day(lastRow.validFrom) as string, lastRow.code, lastRow.id]) : null,
      contracts: pageRows.map((contract) => ({
        id: contract.id,
        code: contract.code,
        status: contract.status,
        hotelId: contract.supplierHotelMapping?.hotel.id ?? null,
        hotelName: contract.supplierHotelMapping?.hotel.name ?? null,
        validFrom: day(contract.validFrom) as string,
        validTo: day(contract.validTo) as string,
        settlementCurrency: contract.settlementCurrency.trim(),
        ratePlansTruncated: contract._count.ratePlans > contract.ratePlans.length,
        ratePlans: contract.ratePlans.map((plan) => ({
          id: plan.id,
          code: plan.code,
          status: plan.status,
          roomTypeName: plan.roomType.name,
          boardBasis: plan.boardBasis.name,
          refundable: plan.refundable,
          occupancy: plan.occupancy,
          currency: plan.currency.trim(),
          validFrom: day(plan.validFrom),
          validTo: day(plan.validTo),
        })),
      })),
    }
  }

  async saveRoomDraft(tenantId: string, userId: string, supplierId: string, hotelId: string, roomTypeId: string, supplierNotes: string, requestId?: string) {
    await this.requirePermission(tenantId, userId, 'supplier.extranet.drafts.manage')
    const notes = supplierNotes.trim()
    if (notes.length < 1 || notes.length > 500) throw new BadRequestException('Invalid draft note')
    return this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const mapping = await tx.supplierHotelMapping.findFirst({
        where: { tenantId, supplierId, hotelId, status: { in: [...VISIBLE_MAPPING] } },
        select: { id: true },
      })
      if (!mapping) throw new NotFoundException('Hotel not found')
      const room = await tx.roomType.findFirst({ where: { id: roomTypeId, hotelId }, select: { id: true } })
      if (!room) throw new NotFoundException('Room not found')
      const draft = await tx.supplierRoomDraft.upsert({
        where: { tenantId_supplierId_roomTypeId: { tenantId, supplierId, roomTypeId } },
        create: { tenantId, supplierId, hotelId, roomTypeId, supplierNotes: notes },
        update: { supplierNotes: notes },
      })
      await tx.auditEvent.create({
        data: {
          tenantId,
          userId,
          actorType: 'USER',
          action: 'supplier.room_draft.updated',
          entityType: 'supplier_room_draft',
          entityId: draft.id,
          payload: { outcome: 'allowed', requestId: requestId ?? null, fields: ['supplierNotes'] },
        },
      })
      return {
        id: draft.id,
        hotelId: draft.hotelId,
        roomTypeId: draft.roomTypeId,
        supplierNotes: draft.supplierNotes,
        updatedAt: draft.updatedAt.toISOString(),
      }
    })
  }
}
