import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { CancellationPolicyService, type CancellationSimulationRule } from '../agent/cancellation-policy.service'
import { LedgerService } from '../agent/ledger.service'
import { CancellationNotificationService } from './cancellation-notification.service'
import {
  assertApprovedSecretReference,
  evaluateBedbankCancellationExecution,
  normalizeConnectorInventoryPayload,
} from './bedbank-connector.adapter'
import type { CancellationVoucherChannel, ConnectorFormatType } from '@bedbanks/contracts'
import type { Prisma } from '@prisma/client'

const date = (value: string) => { const parsed = new Date(`${value}T00:00:00.000Z`); if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Invalid date'); return parsed }
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const minorBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim())
  throw new BadRequestException(`Invalid ${field}`)
}

@Injectable()
export class SupplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AgentAuditService,
    private readonly cancellationPolicy: CancellationPolicyService,
    private readonly ledger: LedgerService,
    private readonly notifications: CancellationNotificationService,
  ) { void this.audit }
  private async permitted(tenantId: string, userId: string, permission: string) {
    const result: any[] = await this.prisma.withTenant(tenantId, tx => tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } })) as any[]
    const keys = result.flatMap((role: any) => role.role.permissions.map((item: any) => item.permission.key))
    if (!keys.includes(permission)) throw new ForbiddenException('Insufficient permission')
  }
  private async check(tenantId: string, userId: string, permission: string) { await this.permitted(tenantId, userId, permission) }
  private async write<T>(tenantId: string, userId: string, permission: string, action: string, entityType: string, requestId: string | undefined, work: (tx: Prisma.TransactionClient) => Promise<{ id: string; value: T }>) {
    await this.check(tenantId, userId, permission)
    return this.prisma.withTenant(tenantId, async tx => {
      const result = await work(tx)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action, entityType, entityId: result.id, payload: { outcome: 'allowed', requestId: requestId ?? null } } })
      return result.value
    })
  }
  async suppliers(tenantId: string, userId: string, query: { search?: string; status?: string; page?: number; pageSize?: number } = {}) {
    await this.check(tenantId, userId, 'supply.suppliers.read')
    const page = Number.isInteger(query.page) && (query.page ?? 0) > 0 ? query.page! : 1
    const pageSize = Number.isInteger(query.pageSize) ? Math.min(Math.max(query.pageSize!, 1), 100) : 25
    const search = clean(query.search)
    const allowedStatuses = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE']
    if (query.status && !allowedStatuses.includes(query.status)) throw new BadRequestException('Invalid supplier status')
    return this.prisma.withTenant(tenantId, async tx => {
      const where: Prisma.SupplierWhereInput = { tenantId, ...(query.status ? { status: query.status as any } : {}), ...(search ? { OR: [{ legalName: { contains: search, mode: 'insensitive' } }, { displayName: { contains: search, mode: 'insensitive' } }] } : {}) }
      const [items, total] = await Promise.all([
        tx.supplier.findMany({ where, orderBy: { displayName: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
        tx.supplier.count({ where }),
      ])
      return { items, page, pageSize, total }
    })
  }
  async supplier(tenantId: string, userId: string, supplierId: string) {
    await this.check(tenantId, userId, 'supply.suppliers.read')
    const value = await this.prisma.withTenant(tenantId, tx => tx.supplier.findFirst({ where: { id: supplierId, tenantId } }))
    if (!value) throw new NotFoundException('Supplier not found')
    return value
  }
  private supplierData(input: any) {
    const legalName = clean(input.legalName), displayName = clean(input.displayName)
    const countryCode = clean(input.countryCode).toUpperCase(), defaultCurrency = clean(input.defaultCurrency).toUpperCase()
    const types = ['HOTEL_DIRECT', 'DMC', 'CHANNEL_MANAGER', 'BEDBANK', 'GDS']
    const statuses = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE']
    if (!legalName || !displayName || !types.includes(input.type) || !statuses.includes(input.status ?? 'DRAFT') || !/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(defaultCurrency)) throw new BadRequestException('Invalid supplier fields')
    if (input.contactMetadata !== undefined && (input.contactMetadata === null || Array.isArray(input.contactMetadata) || typeof input.contactMetadata !== 'object')) throw new BadRequestException('Invalid supplier contact metadata')
    return { legalName, displayName, type: input.type, status: input.status ?? 'DRAFT', countryCode, defaultCurrency, contactMetadata: input.contactMetadata ?? {} }
  }
  async createSupplier(tenantId: string, userId: string, input: any, requestId?: string) {
    const data = this.supplierData(input)
    return this.write(tenantId, userId, 'supply.suppliers.manage', 'supply.supplier.created', 'supplier', requestId, async tx => {
      const duplicate = await tx.supplier.findFirst({ where: { tenantId, legalName: data.legalName } })
      if (duplicate) throw new BadRequestException('Supplier legal name already exists')
      const value = await tx.supplier.create({ data: { tenantId, ...data } as any })
      return { id: value.id, value }
    })
  }
  async updateSupplier(tenantId: string, userId: string, supplierId: string, input: any, requestId?: string) {
    const allowed = ['legalName', 'displayName', 'type', 'status', 'countryCode', 'defaultCurrency', 'contactMetadata']
    if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestException('Invalid supplier fields')
    const current = await this.prisma.withTenant(tenantId, tx => tx.supplier.findFirst({ where: { id: supplierId, tenantId } }))
    if (!current) throw new NotFoundException('Supplier not found')
    const data = this.supplierData({ ...current, ...input })
    return this.write(tenantId, userId, 'supply.suppliers.manage', 'supply.supplier.updated', 'supplier', requestId, async tx => {
      const duplicate = await tx.supplier.findFirst({ where: { tenantId, legalName: data.legalName, NOT: { id: supplierId } } })
      if (duplicate) throw new BadRequestException('Supplier legal name already exists')
      const value = await tx.supplier.update({ where: { id: supplierId }, data: data as any })
      return { id: value.id, value }
    })
  }
  async boardBasesAdmin(tenantId: string, userId: string) {
    await this.check(tenantId, userId, 'supply.rates.read')
    return this.prisma.withTenant(tenantId, async tx => (await tx.boardBasis.findMany({ where: { tenantId }, orderBy: { code: 'asc' } })).map(value => ({ ...value, code: value.code.trim() })))
  }
  private boardBasisData(input: any) {
    const code = clean(input.code).toUpperCase(), name = clean(input.name)
    if (!/^[A-Z0-9]{1,3}$/.test(code) || !name || (input.isActive !== undefined && typeof input.isActive !== 'boolean')) throw new BadRequestException('Invalid board basis fields')
    return { code, name, description: input.description == null ? null : clean(input.description), isActive: input.isActive ?? true }
  }
  async createBoardBasis(tenantId: string, userId: string, input: any, requestId?: string) {
    const data = this.boardBasisData(input)
    return this.write(tenantId, userId, 'supply.rates.manage', 'supply.board_basis.created', 'board_basis', requestId, async tx => {
      const duplicate = await tx.boardBasis.findFirst({ where: { tenantId, code: data.code } })
      if (duplicate) throw new BadRequestException('Board basis code already exists')
      const value = await tx.boardBasis.create({ data: { tenantId, ...data } })
      return { id: value.id, value: { ...value, code: value.code.trim() } }
    })
  }
  async updateBoardBasis(tenantId: string, userId: string, boardBasisId: string, input: any, requestId?: string) {
    const allowed = ['name', 'description', 'isActive']
    if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestException('Canonical board basis code cannot be changed')
    return this.write(tenantId, userId, 'supply.rates.manage', 'supply.board_basis.updated', 'board_basis', requestId, async tx => {
      const current = await tx.boardBasis.findFirst({ where: { id: boardBasisId, tenantId } })
      if (!current) throw new NotFoundException('Board basis not found')
      if (input.name !== undefined && !clean(input.name)) throw new BadRequestException('Board basis name is required')
      const value = await tx.boardBasis.update({ where: { id: boardBasisId }, data: { ...(input.name !== undefined ? { name: clean(input.name) } : {}), ...(input.description !== undefined ? { description: input.description == null ? null : clean(input.description) } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) } })
      return { id: value.id, value: { ...value, code: value.code.trim() } }
    })
  }

  async hotels(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.hotels.read'); return this.prisma.withTenant(tenantId, tx => tx.hotel.findMany({ where: { tenantId }, orderBy: { name: 'asc' } })) }
  async hotel(tenantId: string, userId: string, hotelId: string) { await this.check(tenantId, userId, 'supply.hotels.read'); const hotel = await this.prisma.withTenant(tenantId, tx => tx.hotel.findFirst({ where: { id: hotelId, tenantId }, include: { roomTypes: { where: { isActive: true }, orderBy: { name: 'asc' } } } })); if (!hotel) throw new NotFoundException('Hotel not found'); return hotel }
  private hotelData(tenantId: string, input: any) { const name = clean(input.name); const propertyType = clean(input.propertyType); const city = clean(input.city); const countryCode = clean(input.countryCode).toUpperCase(); const timeZone = clean(input.timeZone) || 'Asia/Dubai'; if (!name || !propertyType || !city || !/^[A-Z]{2}$/.test(countryCode) || (input.starRating !== undefined && input.starRating !== null && (!Number.isInteger(input.starRating) || input.starRating < 1 || input.starRating > 5))) throw new BadRequestException('Invalid hotel fields'); return { tenantId, name, propertyType, starRating: input.starRating ?? null, address: input.address == null ? null : clean(input.address), city, countryCode, timeZone, externalRef: input.externalRef == null ? null : clean(input.externalRef) } }
  async createHotel(tenantId: string, userId: string, input: any, requestId?: string) { const data = this.hotelData(tenantId, input); return this.write(tenantId, userId, 'supply.hotels.manage', 'supply.hotel.created', 'hotel', requestId, async tx => { const value = await tx.hotel.create({ data }); return { id: value.id, value } }) }
  async updateHotel(tenantId: string, userId: string, hotelId: string, input: any, requestId?: string) { const allowed = ['name', 'propertyType', 'starRating', 'address', 'city', 'countryCode', 'timeZone', 'externalRef']; if (Object.keys(input).some((key) => !allowed.includes(key) || key === 'tenantId')) throw new BadRequestException('Invalid hotel fields'); const current = await this.prisma.withTenant(tenantId, tx => tx.hotel.findFirst({ where: { id: hotelId, tenantId } })); if (!current) throw new NotFoundException('Hotel not found'); const data = this.hotelData(tenantId, { ...current, ...input }); return this.write(tenantId, userId, 'supply.hotels.manage', 'supply.hotel.updated', 'hotel', requestId, async tx => { const value = await tx.hotel.update({ where: { id: hotelId }, data }); return { id: value.id, value } }) }
  private roomData(input: any) {
    const name = clean(input.name)
    const code = clean(input.code)
    const maxAdults = input.maxAdults
    const maxChildren = input.maxChildren ?? 0
    const maxOccupancy = input.maxOccupancy
    if (!name || !code || !Number.isInteger(maxAdults) || !Number.isInteger(maxChildren) || !Number.isInteger(maxOccupancy) || maxAdults < 1 || maxChildren < 0 || maxOccupancy < maxAdults + maxChildren) throw new BadRequestException('Invalid room fields')
    if (input.beddingMetadata !== undefined && (input.beddingMetadata === null || Array.isArray(input.beddingMetadata) || typeof input.beddingMetadata !== 'object')) throw new BadRequestException('Invalid bedding metadata')
    if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new BadRequestException('Invalid room status')
    return { name, code, maxAdults, maxChildren, maxOccupancy, beddingMetadata: input.beddingMetadata ?? {}, isActive: input.isActive ?? true }
  }
  private async tenantHotel(tx: Prisma.TransactionClient, tenantId: string, hotelId: string) {
    const hotel = await tx.hotel.findFirst({ where: { id: hotelId, tenantId } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel
  }
  async roomsForHotel(tenantId: string, userId: string, hotelId: string) {
    await this.check(tenantId, userId, 'supply.rooms.read')
    return this.prisma.withTenant(tenantId, async tx => { await this.tenantHotel(tx, tenantId, hotelId); return tx.roomType.findMany({ where: { hotelId }, orderBy: { name: 'asc' } }) })
  }
  async room(tenantId: string, userId: string, hotelId: string, roomId: string) {
    await this.check(tenantId, userId, 'supply.rooms.read')
    const room = await this.prisma.withTenant(tenantId, async tx => { await this.tenantHotel(tx, tenantId, hotelId); return tx.roomType.findFirst({ where: { id: roomId, hotelId } }) })
    if (!room) throw new NotFoundException('Room not found')
    return room
  }
  async createRoom(tenantId: string, userId: string, hotelId: string, input: any, requestId?: string) {
    if (Object.keys(input).some(key => !['name', 'code', 'maxAdults', 'maxChildren', 'maxOccupancy', 'beddingMetadata', 'isActive'].includes(key))) throw new BadRequestException('Invalid room fields')
    const data = this.roomData(input)
    return this.write(tenantId, userId, 'supply.rooms.manage', 'supply.room.created', 'room_type', requestId, async tx => { await this.tenantHotel(tx, tenantId, hotelId); const value = await tx.roomType.create({ data: { hotelId, ...data } }); return { id: value.id, value } })
  }
  async updateRoom(tenantId: string, userId: string, hotelId: string, roomId: string, input: any, requestId?: string) {
    const allowed = ['name', 'code', 'maxAdults', 'maxChildren', 'maxOccupancy', 'beddingMetadata', 'isActive']
    if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key) || key === 'hotelId' || key === 'tenantId')) throw new BadRequestException('Invalid room fields')
    return this.write(tenantId, userId, 'supply.rooms.manage', 'supply.room.updated', 'room_type', requestId, async tx => {
      await this.tenantHotel(tx, tenantId, hotelId)
      const current = await tx.roomType.findFirst({ where: { id: roomId, hotelId } })
      if (!current) throw new NotFoundException('Room not found')
      const data = this.roomData({ ...current, ...input })
      const value = await tx.roomType.update({ where: { id: roomId }, data })
      return { id: value.id, value }
    })
  }
  async roomTypes(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.rooms.read'); return this.prisma.withTenant(tenantId, tx => tx.roomType.findMany({ where: { hotel: { tenantId } }, orderBy: { name: 'asc' } })) }
  async createRoomType(tenantId: string, userId: string, input: any, requestId?: string) { if (!Number.isInteger(input.maxAdults) || !Number.isInteger(input.maxChildren ?? 0) || !Number.isInteger(input.maxOccupancy) || input.maxAdults < 1 || (input.maxChildren ?? 0) < 0 || input.maxOccupancy < input.maxAdults + (input.maxChildren ?? 0)) throw new BadRequestException('Invalid occupancy'); return this.write(tenantId, userId, 'supply.rooms.manage', 'supply.room.created', 'room_type', requestId, async tx => { const hotel = await tx.hotel.findFirst({ where: { id: input.hotelId, tenantId } }); if (!hotel) throw new BadRequestException('Hotel does not belong to tenant'); const value = await tx.roomType.create({ data: { hotelId: input.hotelId, name: clean(input.name), code: clean(input.code), maxAdults: input.maxAdults, maxChildren: input.maxChildren ?? 0, maxOccupancy: input.maxOccupancy, beddingMetadata: input.beddingMetadata ?? {} } }); return { id: value.id, value } }) }
  async boardBases(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.rates.read'); return this.prisma.withTenant(tenantId, tx => tx.boardBasis.findMany({ where: { tenantId, isActive: true }, orderBy: { code: 'asc' } })) }
  async contracts(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.contracts.read'); return this.prisma.withTenant(tenantId, tx => tx.contract.findMany({ where: { tenantId }, include: { supplier: { select: { id: true, displayName: true } }, supplierHotelMapping: { select: { id: true, hotelId: true, status: true } } }, orderBy: { validFrom: 'desc' } })) }
  async contract(tenantId: string, userId: string, contractId: string) { await this.check(tenantId, userId, 'supply.contracts.read'); const value = await this.prisma.withTenant(tenantId, tx => tx.contract.findFirst({ where: { id: contractId, tenantId }, include: { supplier: { select: { id: true, displayName: true } }, supplierHotelMapping: { select: { id: true, hotelId: true, status: true } }, cancellationPolicies: { orderBy: { daysBeforeCheckin: 'desc' } }, childPolicies: { orderBy: { minAge: 'asc' } }, leadTimeRules: true } })); if (!value) throw new NotFoundException('Contract not found'); return value }
  async createContract(tenantId: string, userId: string, input: any, requestId?: string) { const from = date(input.validFrom); const to = date(input.validTo); if (to < from) throw new BadRequestException('Invalid contract validity'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.created', 'contract', requestId, async tx => { const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId } }); if (!supplier) throw new BadRequestException('Supplier does not belong to tenant'); if (input.supplierHotelMappingId) { const mapping = await tx.supplierHotelMapping.findFirst({ where: { id: input.supplierHotelMappingId, tenantId, supplierId: input.supplierId, status: 'MAPPED' } }); if (!mapping) throw new BadRequestException('Invalid supplier hotel mapping') } const value = await tx.contract.create({ data: { tenantId, supplierId: input.supplierId, supplierHotelMappingId: input.supplierHotelMappingId ?? null, code: clean(input.code), validFrom: from, validTo: to, settlementCurrency: clean(input.settlementCurrency).toUpperCase(), salesMarkets: input.salesMarkets ?? [], nationalities: input.nationalities ?? [] } }); return { id: value.id, value } }) }
  async updateContract(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) {
    return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.updated', 'contract', requestId, async tx => {
      const current = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!current) throw new NotFoundException('Contract not found')
      const validFrom = input.validFrom === undefined ? current.validFrom : date(input.validFrom), validTo = input.validTo === undefined ? current.validTo : date(input.validTo)
      if (validTo < validFrom) throw new BadRequestException('Invalid contract validity')
      const supplierId = input.supplierId ?? current.supplierId; const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId } }); if (!supplier) throw new BadRequestException('Supplier does not belong to tenant')
      const mappingId = input.supplierHotelMappingId === undefined ? current.supplierHotelMappingId : input.supplierHotelMappingId
      if (mappingId) { const mapping = await tx.supplierHotelMapping.findFirst({ where: { id: mappingId, tenantId, supplierId, status: 'MAPPED' } }); if (!mapping) throw new BadRequestException('Invalid supplier hotel mapping') }
      const value = await tx.contract.update({ where: { id: contractId }, data: { ...(input.supplierId !== undefined ? { supplierId } : {}), ...(input.supplierHotelMappingId !== undefined ? { supplierHotelMappingId: mappingId } : {}), ...(input.code !== undefined ? { code: clean(input.code) } : {}), ...(input.status !== undefined ? { status: input.status } : {}), validFrom, validTo, ...(input.settlementCurrency !== undefined ? { settlementCurrency: clean(input.settlementCurrency).toUpperCase() } : {}), ...(input.salesMarkets !== undefined ? { salesMarkets: input.salesMarkets } : {}), ...(input.nationalities !== undefined ? { nationalities: input.nationalities } : {}), ...(input.paymentPolicyRef !== undefined ? { paymentPolicyRef: input.paymentPolicyRef == null ? null : clean(input.paymentPolicyRef) } : {}) } })
      return { id: value.id, value }
    })
  }
  async contractPolicies(tenantId: string, userId: string, contractId: string) { await this.check(tenantId, userId, 'supply.contracts.read'); const value = await this.prisma.withTenant(tenantId, tx => tx.contract.findFirst({ where: { id: contractId, tenantId }, select: { id: true, cancellationPolicies: { orderBy: { daysBeforeCheckin: 'desc' } }, childPolicies: { orderBy: { minAge: 'asc' } }, leadTimeRules: true } })); if (!value) throw new NotFoundException('Contract not found'); return { ...value, cancellationPolicies: value.cancellationPolicies.map(policy => ({ ...policy, penaltyMinor: policy.penaltyMinor?.toString() ?? null })), childPolicies: value.childPolicies.map(policy => ({ ...policy, supplementMinor: policy.supplementMinor?.toString() ?? null })) } }
  async createCancellationPolicy(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) {
    if (!Number.isInteger(input.daysBeforeCheckin) || input.daysBeforeCheckin < 0 || ((input.penaltyPercent !== undefined) === (input.penaltyMinor !== undefined)) || (input.penaltyPercent !== undefined && (!Number.isInteger(input.penaltyPercent) || input.penaltyPercent < 0 || input.penaltyPercent > 100))) throw new BadRequestException('Invalid cancellation policy')
    const penaltyMinor = input.penaltyMinor === undefined ? null : minorBigInt(input.penaltyMinor, 'penaltyMinor')
    if (penaltyMinor !== null && penaltyMinor < 0n) throw new BadRequestException('Invalid cancellation policy')
    return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.cancellation_policy.created', 'cancellation_policy', requestId, async tx => {
      const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } })
      if (!contract) throw new NotFoundException('Contract not found')
      const duplicate = await tx.cancellationPolicy.findFirst({ where: { contractId, daysBeforeCheckin: input.daysBeforeCheckin } })
      if (duplicate) throw new BadRequestException('Cancellation policy window for this deadline already exists')
      const currency = input.currency == null ? null : clean(input.currency).toUpperCase()
      if (currency && currency.length !== 3) throw new BadRequestException('Invalid policy currency')
      const value = await tx.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: input.daysBeforeCheckin, penaltyPercent: input.penaltyPercent ?? null, penaltyMinor, currency } })
      return { id: value.id, value: { ...value, penaltyMinor: value.penaltyMinor?.toString() ?? null } }
    })
  }
  async simulateCancellationPolicy(tenantId: string, userId: string, contractId: string, input: any) {
    await this.check(tenantId, userId, 'supply.contracts.read')
    const contract = await this.prisma.withTenant(tenantId, tx => tx.contract.findFirst({
      where: { id: contractId, tenantId },
      include: {
        cancellationPolicies: { orderBy: { daysBeforeCheckin: 'desc' } },
        supplierHotelMapping: { include: { hotel: { select: { timeZone: true } } } },
      },
    }))
    if (!contract) throw new NotFoundException('Contract not found')
    const checkIn = clean(input.checkIn)
    const requestedAt = clean(input.requestedAt)
    const currency = clean(input.currency || contract.settlementCurrency).toUpperCase()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !requestedAt || !/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('Invalid simulation parameters')
    }
    const policyType = input.policyType ?? 'REFUNDABLE'
    if (!['REFUNDABLE', 'NON_REFUNDABLE', 'CONDITIONAL'].includes(policyType)) {
      throw new BadRequestException('Invalid policyType')
    }
    const deadlineSemantics = input.deadlineSemantics ?? 'CALENDAR_DAYS_AT_LOCAL_TIME'
    if (!['CALENDAR_DAYS_AT_LOCAL_TIME', 'ELAPSED_HOURS'].includes(deadlineSemantics)) {
      throw new BadRequestException('Invalid deadlineSemantics')
    }
    const cancellableAmountMinor = minorBigInt(input.cancellableAmountMinor, 'cancellableAmountMinor')
    const nightlyAmountsMinor = Array.isArray(input.nightlyAmountsMinor)
      ? input.nightlyAmountsMinor.map((item: unknown) => minorBigInt(item, 'nightlyAmountsMinor'))
      : undefined
    const customerAmountPaidMinor = input.customerAmountPaidMinor == null ? undefined : minorBigInt(input.customerAmountPaidMinor, 'customerAmountPaidMinor')
    const retainedFeesMinor = input.retainedFeesMinor == null ? undefined : minorBigInt(input.retainedFeesMinor, 'retainedFeesMinor')
    const priorRefundsMinor = input.priorRefundsMinor == null ? undefined : minorBigInt(input.priorRefundsMinor, 'priorRefundsMinor')
    const supplierCancellableAmountMinor = input.supplierCancellableAmountMinor == null ? undefined : minorBigInt(input.supplierCancellableAmountMinor, 'supplierCancellableAmountMinor')
    const supplierPenaltyOverrideMinor = input.supplierPenaltyOverrideMinor == null ? undefined : minorBigInt(input.supplierPenaltyOverrideMinor, 'supplierPenaltyOverrideMinor')
    const propertyTimeZone = clean(input.propertyTimeZone) || contract.supplierHotelMapping?.hotel?.timeZone || 'Asia/Dubai'
    const checkInLocalTime = clean(input.checkInLocalTime) || '15:00'

    const rules: CancellationSimulationRule[] = Array.isArray(input.rules)
      ? input.rules.map((rule: any) => ({
          ...(rule.daysBeforeCheckin !== undefined ? { daysBeforeCheckin: Number(rule.daysBeforeCheckin) } : {}),
          ...(rule.elapsedHoursBeforeCheckin !== undefined ? { elapsedHoursBeforeCheckin: Number(rule.elapsedHoursBeforeCheckin) } : {}),
          ...(rule.penaltyType ? { penaltyType: rule.penaltyType } : {}),
          ...(rule.penaltyPercent != null ? { penaltyPercent: Number(rule.penaltyPercent) } : {}),
          ...(rule.penaltyMinor != null ? { penaltyMinor: minorBigInt(rule.penaltyMinor, 'penaltyMinor') } : {}),
          ...(rule.penaltyNights != null ? { penaltyNights: Number(rule.penaltyNights) } : {}),
          ...(rule.currency ? { currency: clean(rule.currency).toUpperCase() } : {}),
        }))
      : contract.cancellationPolicies.map(rule => ({
          daysBeforeCheckin: rule.daysBeforeCheckin,
          ...(rule.penaltyPercent !== null ? { penaltyPercent: rule.penaltyPercent } : {}),
          ...(rule.penaltyMinor !== null ? { penaltyMinor: rule.penaltyMinor } : {}),
          ...(rule.currency !== null ? { currency: rule.currency } : {}),
        }))

    const simulated = this.cancellationPolicy.simulate({
      cancellableAmountMinor,
      nightlyAmountsMinor,
      currency,
      checkIn,
      requestedAt,
      policyType,
      deadlineSemantics,
      propertyTimeZone,
      checkInLocalTime,
      customerAmountPaidMinor,
      retainedFeesMinor,
      priorRefundsMinor,
      supplierCancellableAmountMinor,
      supplierPenaltyOverrideMinor,
      rules,
    })

    return {
      ...simulated,
      cancellableAmountMinor: simulated.cancellableAmountMinor.toString(),
      penaltyMinor: simulated.penaltyMinor.toString(),
      refundMinor: simulated.refundMinor.toString(),
      customerCancellationLiabilityMinor: simulated.customerCancellationLiabilityMinor.toString(),
      customerRefundEntitlementMinor: simulated.customerRefundEntitlementMinor.toString(),
      customerRefundPayableMinor: simulated.customerRefundPayableMinor.toString(),
      settlementBalanceMinor: simulated.settlementBalanceMinor.toString(),
      supplierPenaltyMinor: simulated.supplierPenaltyMinor.toString(),
      supplierExpectedCreditMinor: simulated.supplierExpectedCreditMinor.toString(),
    }
  }
  async createChildPolicy(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) { if (!Number.isInteger(input.minAge) || !Number.isInteger(input.maxAge) || input.minAge < 0 || input.maxAge < input.minAge || input.maxAge > 17) throw new BadRequestException('Invalid child policy ages'); const supplementMinor = input.supplementMinor == null ? null : BigInt(input.supplementMinor); if (supplementMinor !== null && supplementMinor < 0n) throw new BadRequestException('Invalid child supplement'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.child_policy.created', 'child_policy', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!contract) throw new NotFoundException('Contract not found'); const overlap = await tx.childPolicy.findFirst({ where: { contractId, minAge: { lte: input.maxAge }, maxAge: { gte: input.minAge } } }); if (overlap) throw new BadRequestException('Child policy age ranges overlap'); const currency = input.currency == null ? null : clean(input.currency).toUpperCase(); if (currency && currency.length !== 3) throw new BadRequestException('Invalid policy currency'); const value = await tx.childPolicy.create({ data: { contractId, minAge: input.minAge, maxAge: input.maxAge, extraBedAllowed: input.extraBedAllowed ?? false, supplementMinor, currency } }); return { id: value.id, value: { ...value, supplementMinor: value.supplementMinor?.toString() ?? null } } }) }
  async createLeadTimeRule(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) { if (!Number.isInteger(input.minLeadHours) || input.minLeadHours < 0 || (input.maxLeadDays != null && (!Number.isInteger(input.maxLeadDays) || input.maxLeadDays < 0))) throw new BadRequestException('Invalid lead-time rule'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.lead_time_rule.updated', 'booking_lead_time_rule', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!contract) throw new NotFoundException('Contract not found'); const value = await tx.bookingLeadTimeRule.upsert({ where: { contractId }, update: { minLeadHours: input.minLeadHours, maxLeadDays: input.maxLeadDays ?? null }, create: { contractId, minLeadHours: input.minLeadHours, maxLeadDays: input.maxLeadDays ?? null } }); return { id: value.id, value } }) }

  async ratePlans(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.rates.read'); return this.prisma.withTenant(tenantId, tx => tx.ratePlan.findMany({ where: { tenantId }, include: { contract: { include: { supplier: { select: { id: true, displayName: true } } } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true }, orderBy: { code: 'asc' } })) }
  async ratePlan(tenantId: string, userId: string, ratePlanId: string) { await this.check(tenantId, userId, 'supply.rates.read'); const value = await this.prisma.withTenant(tenantId, tx => tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, include: { contract: { include: { supplier: { select: { id: true, displayName: true } }, supplierHotelMapping: true } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true } })); if (!value) throw new NotFoundException('Rate plan not found'); return value }
  async createRatePlan(tenantId: string, userId: string, input: any, requestId?: string) { if (!Number.isInteger(input.occupancy) || input.occupancy < 1) throw new BadRequestException('Invalid occupancy'); return this.write(tenantId, userId, 'supply.rates.manage', 'supply.rate_plan.created', 'rate_plan', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: input.contractId, tenantId }, include: { supplierHotelMapping: true } }); const room = await tx.roomType.findFirst({ where: { id: input.roomTypeId, hotel: { tenantId } } }); const board = await tx.boardBasis.findFirst({ where: { id: input.boardBasisId, tenantId, isActive: true } }); if (!contract || !room || !board) throw new BadRequestException('Invalid rate plan relationship'); if (contract.supplierHotelMapping && contract.supplierHotelMapping.hotelId !== room.hotelId) throw new BadRequestException('Contract and room hotel mismatch'); const value = await tx.ratePlan.create({ data: { tenantId, contractId: input.contractId, roomTypeId: input.roomTypeId, boardBasisId: input.boardBasisId, code: clean(input.code), occupancy: input.occupancy, currency: clean(input.currency).toUpperCase(), refundable: input.refundable ?? true, taxesIncluded: input.taxesIncluded ?? false, feesIncluded: input.feesIncluded ?? false, minStay: input.minStay ?? 1, maxStay: input.maxStay ?? null, releaseDays: input.releaseDays ?? 0 } }); return { id: value.id, value } }) }
  async updateRatePlan(tenantId: string, userId: string, ratePlanId: string, input: any, requestId?: string) {
    return this.write(tenantId, userId, 'supply.rates.manage', 'supply.rate_plan.updated', 'rate_plan', requestId, async tx => {
      const current = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId } }); if (!current) throw new NotFoundException('Rate plan not found')
      const contractId = input.contractId ?? current.contractId, roomTypeId = input.roomTypeId ?? current.roomTypeId, boardBasisId = input.boardBasisId ?? current.boardBasisId
      const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId }, include: { supplierHotelMapping: true } })
      const room = await tx.roomType.findFirst({ where: { id: roomTypeId, hotel: { tenantId } } })
      const board = await tx.boardBasis.findFirst({ where: { id: boardBasisId, tenantId, isActive: true } })
      if (!contract || !room || !board) throw new BadRequestException('Invalid rate plan relationship')
      if (contract.supplierHotelMapping && contract.supplierHotelMapping.hotelId !== room.hotelId) throw new BadRequestException('Contract and room hotel mismatch')
      const occupancy = input.occupancy ?? current.occupancy; if (!Number.isInteger(occupancy) || occupancy < 1 || occupancy > room.maxOccupancy) throw new BadRequestException('Invalid occupancy')
      const minStay = input.minStay ?? current.minStay, maxStay = input.maxStay === undefined ? current.maxStay : input.maxStay, releaseDays = input.releaseDays ?? current.releaseDays
      if (!Number.isInteger(minStay) || minStay < 1 || (maxStay != null && (!Number.isInteger(maxStay) || maxStay < minStay)) || !Number.isInteger(releaseDays) || releaseDays < 0) throw new BadRequestException('Invalid stay or release rule')
      const currency = input.currency === undefined ? current.currency : clean(input.currency).toUpperCase(); if (currency.length !== 3) throw new BadRequestException('Invalid currency')
      const value = await tx.ratePlan.update({ where: { id: ratePlanId }, data: { contractId, roomTypeId, boardBasisId, ...(input.code !== undefined ? { code: clean(input.code) } : {}), ...(input.status !== undefined ? { status: input.status } : {}), occupancy, currency, ...(input.refundable !== undefined ? { refundable: input.refundable } : {}), ...(input.taxesIncluded !== undefined ? { taxesIncluded: input.taxesIncluded } : {}), ...(input.feesIncluded !== undefined ? { feesIncluded: input.feesIncluded } : {}), minStay, maxStay, releaseDays } })
      return { id: value.id, value }
    })
  }

  async dailyRates(tenantId: string, userId: string, input: any) {
    await this.check(tenantId, userId, 'supply.rates.read')
    const from = date(input.from), to = date(input.to)
    if (from > to) throw new BadRequestException('Invalid date range')
    return this.prisma.withTenant(tenantId, tx => tx.dailyRate.findMany({
      where: { tenantId, stayDate: { gte: from, lte: to }, ...(input.ratePlanId ? { ratePlanId: input.ratePlanId } : {}) },
      include: { ratePlan: { include: { roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true } } },
      orderBy: [{ stayDate: 'asc' }, { occupancy: 'asc' }],
    })).then(rows => rows.map(row => ({ ...row, amountMinor: row.amountMinor.toString() })))
  }

  async availabilityRows(tenantId: string, userId: string, input: any) {
    await this.check(tenantId, userId, 'supply.availability.read')
    const from = date(input.from), to = date(input.to)
    if (from > to) throw new BadRequestException('Invalid date range')
    return this.prisma.withTenant(tenantId, tx => tx.dailyAvailability.findMany({
      where: { tenantId, stayDate: { gte: from, lte: to }, ...(input.ratePlanId ? { ratePlanId: input.ratePlanId } : {}) },
      include: { ratePlan: { include: { roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true } } },
      orderBy: { stayDate: 'asc' },
    }))
  }

  async bulkAvailability(tenantId: string, userId: string, input: any, requestId?: string) {
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 366) throw new BadRequestException('Invalid availability rows')
    await this.check(tenantId, userId, 'supply.availability.manage')
    const results = []
    for (const row of input.rows) results.push(await this.upsertAvailability(tenantId, userId, row, requestId))
    return results
  }

  async bulkDailyRates(tenantId: string, userId: string, input: any, requestId?: string) {
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 366) throw new BadRequestException('Invalid daily rate rows')
    await this.check(tenantId, userId, 'supply.rates.manage')
    const results = []
    for (const row of input.rows) results.push(await this.upsertDailyRate(tenantId, userId, row, requestId))
    return results
  }

  async upsertDailyRate(tenantId: string, userId: string, input: any, requestId?: string) { if ((!Number.isSafeInteger(input.amountMinor) && typeof input.amountMinor !== 'string') || !Number.isInteger(input.occupancy) || !['NET', 'SELL'].includes(input.amountBasis)) throw new BadRequestException('Invalid daily rate'); const amountMinor = BigInt(input.amountMinor); if (amountMinor < 0n) throw new BadRequestException('amountMinor must be non-negative'); return this.write(tenantId, userId, 'supply.rates.manage', 'supply.daily_rate.updated', 'daily_rate', requestId, async tx => { const plan = await tx.ratePlan.findFirst({ where: { id: input.ratePlanId, tenantId } }); if (!plan || plan.currency !== clean(input.currency).toUpperCase()) throw new BadRequestException('Rate plan or currency is invalid'); const value = await tx.dailyRate.upsert({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: input.ratePlanId, stayDate: date(input.stayDate), occupancy: input.occupancy } }, update: { amountMinor, amountBasis: input.amountBasis, currency: clean(input.currency).toUpperCase() }, create: { tenantId, ratePlanId: input.ratePlanId, stayDate: date(input.stayDate), occupancy: input.occupancy, amountMinor, amountBasis: input.amountBasis, currency: clean(input.currency).toUpperCase() } }); return { id: value.id, value: { ...value, amountMinor: value.amountMinor.toString() } } }) }
  async upsertAvailability(tenantId: string, userId: string, input: any, requestId?: string) { if (!Number.isInteger(input.allotment) || input.allotment < 0 || (input.sold !== undefined && (!Number.isInteger(input.sold) || input.sold < 0 || input.sold > input.allotment))) throw new BadRequestException('Invalid availability'); return this.write(tenantId, userId, 'supply.availability.manage', 'supply.availability.updated', 'daily_availability', requestId, async tx => { const plan = await tx.ratePlan.findFirst({ where: { id: input.ratePlanId, tenantId } }); if (!plan) throw new BadRequestException('Rate plan does not belong to tenant'); const stayDate = date(input.stayDate); const existing = await tx.dailyAvailability.findUnique({ where: { ratePlanId_stayDate: { ratePlanId: input.ratePlanId, stayDate } } }); if (existing && input.allotment < existing.sold + existing.held) throw new BadRequestException('Allotment cannot be below committed inventory'); const value = await tx.dailyAvailability.upsert({ where: { ratePlanId_stayDate: { ratePlanId: input.ratePlanId, stayDate } }, update: { allotment: input.allotment, stopSell: input.stopSell ?? false, minStay: input.minStay ?? 1 }, create: { tenantId, ratePlanId: input.ratePlanId, stayDate, allotment: input.allotment, sold: input.sold ?? 0, stopSell: input.stopSell ?? false, minStay: input.minStay ?? 1 } }); return { id: value.id, value } }) }
  async sellability(tenantId: string, userId: string, input: any) { await this.check(tenantId, userId, 'supply.rates.read'); const stayDate = date(input.stayDate); const plan = await this.prisma.withTenant(tenantId, tx => tx.ratePlan.findFirst({ where: { id: input.ratePlanId, tenantId }, include: { roomType: { include: { hotel: true } }, boardBasis: true, contract: { include: { supplier: true, supplierHotelMapping: true } }, dailyRates: { where: { stayDate, occupancy: input.occupancy } }, availability: { where: { stayDate } } } })); const reasons: string[] = []; if (!plan) reasons.push('RATE_PLAN_MISSING'); else { if (plan.roomType.hotel.contentStatus === 'SUSPENDED') reasons.push('HOTEL_INACTIVE'); if (!plan.roomType.isActive) reasons.push('ROOM_TYPE_INACTIVE'); if (!plan.boardBasis.isActive) reasons.push('BOARD_BASIS_INACTIVE'); if (plan.contract.supplier.status !== 'ACTIVE') reasons.push('SUPPLIER_INACTIVE'); if (input.occupancy !== plan.occupancy || input.occupancy > plan.roomType.maxOccupancy) reasons.push('OCCUPANCY_UNSUPPORTED'); if (plan.contract.status !== 'ACTIVE') reasons.push('CONTRACT_INACTIVE'); if (stayDate < plan.contract.validFrom || stayDate > plan.contract.validTo) reasons.push('OUTSIDE_CONTRACT_VALIDITY'); if (plan.contract.supplierHotelMapping && (plan.contract.supplierHotelMapping.hotelId !== plan.roomType.hotelId || plan.contract.supplierHotelMapping.status !== 'MAPPED')) reasons.push('SUPPLIER_MAPPING_INVALID'); if (plan.status !== 'ACTIVE') reasons.push('RATE_PLAN_INACTIVE'); const dailyRate = plan.dailyRates[0]; if (!dailyRate || dailyRate.amountMinor < 0n) reasons.push('DAILY_RATE_MISSING_OR_INVALID'); else if (dailyRate.currency !== plan.currency) reasons.push('RATE_CURRENCY_MISMATCH'); else if (dailyRate.amountBasis === null) reasons.push('RATE_AMOUNT_BASIS_UNVERIFIED'); else if (dailyRate.amountBasis === 'NET') reasons.push('NET_RATE_MARKUP_UNAVAILABLE'); const availability = plan.availability[0]; if (!availability) reasons.push('AVAILABILITY_MISSING'); else { if (availability.stopSell) reasons.push('STOP_SELL'); if (availability.allotment - availability.sold - availability.held <= 0) reasons.push('NO_INVENTORY') } } return { eligible: reasons.length === 0, status: reasons.length === 0 ? 'ELIGIBLE_FOR_FUTURE_SEARCH' : 'NOT_ELIGIBLE', reasons } }

  async connectors(tenantId: string, userId: string) {
    await this.check(tenantId, userId, 'supply.suppliers.read')
    return this.prisma.withTenant(tenantId, tx =>
      tx.connectorDefinition.findMany({
        where: { tenantId },
        include: { supplier: { select: { id: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    )
  }

  async createConnector(tenantId: string, userId: string, input: any, requestId?: string) {
    const name = clean(input.name)
    const supplierId = clean(input.supplierId)
    const type = clean(input.type) as ConnectorFormatType
    const status = clean(input.status || 'ACTIVE')
    const version = clean(input.version || 'v1')
    const types = ['API_JSON', 'XML_IN', 'XML_OUT', 'CHANNEL_MANAGER', 'MANUAL_EXTRANET']
    const statuses = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED']
    if (!name || !supplierId || !types.includes(type) || !statuses.includes(status)) {
      throw new BadRequestException('Invalid connector definition fields')
    }
    if (input.secretRef !== undefined && input.secretRef !== null) {
      if (typeof input.secretRef !== 'string') throw new BadRequestException('Invalid secretRef')
      assertApprovedSecretReference(input.secretRef)
    }
    const capabilities = Array.isArray(input.capabilities) ? input.capabilities.map(String) : ['availability', 'cancel']

    return this.write(tenantId, userId, 'supply.suppliers.manage', 'supply.connector.created', 'connector_definition', requestId, async tx => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId } })
      if (!supplier) throw new BadRequestException('Supplier does not belong to tenant')
      const connector = await tx.connectorDefinition.create({
        data: {
          tenantId,
          supplierId,
          type: type as any,
          status: status as any,
          name,
          capabilities,
          version,
          healthState: status === 'ACTIVE' ? 'healthy' : 'unknown',
        },
      })
      if (typeof input.secretRef === 'string' && input.secretRef.trim()) {
        await tx.connectorCredentialReference.create({
          data: {
            connectorId: connector.id,
            secretRef: input.secretRef.trim(),
            purpose: 'primary_transport',
          },
        })
      }
      return { id: connector.id, value: connector }
    })
  }

  async ingestConnectorInventory(tenantId: string, userId: string, connectorId: string, input: any, requestId?: string) {
    await this.check(tenantId, userId, 'supply.availability.manage')
    const idempotencyKey = clean(input.idempotencyKey)
    const format = clean(input.format) as ConnectorFormatType
    if (!idempotencyKey || !['API_JSON', 'XML_IN', 'XML_OUT', 'CHANNEL_MANAGER', 'MANUAL_EXTRANET'].includes(format)) {
      throw new BadRequestException('Invalid connector inventory ingestion request')
    }

    return this.prisma.withTenant(tenantId, async tx => {
      const connector = await tx.connectorDefinition.findFirst({ where: { id: connectorId, tenantId } })
      if (!connector) throw new NotFoundException('Connector not found')
      if (connector.status !== 'ACTIVE') throw new BadRequestException('Connector is not active')

      const existingEvent = await tx.inventoryUpdateEvent.findUnique({
        where: { supplierId_idempotencyKey: { supplierId: connector.supplierId, idempotencyKey } },
      })
      if (existingEvent) {
        const errors = Array.isArray(existingEvent.validationErrors) ? (existingEvent.validationErrors as string[]) : []
        return {
          eventId: existingEvent.id,
          outcome: existingEvent.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
          ingestedRows: 0,
          validationErrors: errors,
        }
      }

      const normalized = normalizeConnectorInventoryPayload(format, input.payload)
      if (normalized.status === 'rejected') {
        const failedEvent = await tx.inventoryUpdateEvent.create({
          data: {
            tenantId,
            supplierId: connector.supplierId,
            connectorId: connector.id,
            idempotencyKey,
            outcome: 'FAILED',
            validationErrors: normalized.errors,
            processedAt: new Date(),
          },
        })
        return {
          eventId: failedEvent.id,
          outcome: 'FAILED' as const,
          ingestedRows: 0,
          validationErrors: normalized.errors,
        }
      }

      const mappingErrors: string[] = []
      let ingestedRows = 0

      for (const item of normalized.items) {
        const hotelMapping = await tx.supplierHotelMapping.findFirst({
          where: {
            tenantId,
            supplierId: connector.supplierId,
            supplierHotelId: item.supplierHotelId,
            status: 'MAPPED',
          },
        })
        if (!hotelMapping) {
          mappingErrors.push(`UNMAPPED_SUPPLIER_HOTEL:${item.supplierHotelId}`)
          continue
        }
        const roomMapping = await tx.supplierRoomMapping.findFirst({
          where: {
            tenantId,
            supplierHotelMappingId: hotelMapping.id,
            supplierRoomId: item.supplierRoomId,
            status: 'MAPPED',
          },
        })
        if (!roomMapping) {
          mappingErrors.push(`UNMAPPED_SUPPLIER_ROOM:${item.supplierRoomId}`)
          continue
        }
        const ratePlan = await tx.ratePlan.findFirst({
          where: {
            tenantId,
            roomTypeId: roomMapping.roomTypeId,
            code: item.ratePlanCode,
            contract: { supplierId: connector.supplierId },
          },
        })
        if (!ratePlan || ratePlan.currency !== item.currency) {
          mappingErrors.push(`UNMAPPED_OR_CURRENCY_MISMATCH_RATE_PLAN:${item.ratePlanCode}`)
          continue
        }

        const stayDate = date(item.stayDate)
        const existingAvail = await tx.dailyAvailability.findUnique({
          where: { ratePlanId_stayDate: { ratePlanId: ratePlan.id, stayDate } },
        })
        if (existingAvail && item.allotment < existingAvail.sold + existingAvail.held) {
          mappingErrors.push(`ALLOTMENT_BELOW_COMMITTED:${item.stayDate}`)
          continue
        }

        await tx.dailyAvailability.upsert({
          where: { ratePlanId_stayDate: { ratePlanId: ratePlan.id, stayDate } },
          update: { allotment: item.allotment, stopSell: item.stopSell, minStay: item.minStay, sourceUpdatedAt: new Date() },
          create: { tenantId, ratePlanId: ratePlan.id, stayDate, allotment: item.allotment, sold: 0, stopSell: item.stopSell, minStay: item.minStay, sourceUpdatedAt: new Date() },
        })

        await tx.dailyRate.upsert({
          where: { ratePlanId_stayDate_occupancy: { ratePlanId: ratePlan.id, stayDate, occupancy: item.occupancy } },
          update: { amountMinor: item.amountMinor, amountBasis: item.amountBasis, currency: item.currency, sourceUpdatedAt: new Date() },
          create: { tenantId, ratePlanId: ratePlan.id, stayDate, occupancy: item.occupancy, amountMinor: item.amountMinor, amountBasis: item.amountBasis, currency: item.currency, sourceUpdatedAt: new Date() },
        })

        ingestedRows += 1
      }

      const outcome = mappingErrors.length === 0 && ingestedRows > 0 ? 'SUCCEEDED' : 'FAILED'
      const event = await tx.inventoryUpdateEvent.create({
        data: {
          tenantId,
          supplierId: connector.supplierId,
          connectorId: connector.id,
          idempotencyKey,
          outcome,
          validationErrors: mappingErrors,
          processedAt: new Date(),
        },
      })

      await tx.connectorExecution.upsert({
        where: { connectorId_correlationId: { connectorId: connector.id, correlationId: idempotencyKey } },
        update: { status: outcome, errorClassification: mappingErrors[0] ?? null },
        create: {
          tenantId,
          connectorId: connector.id,
          correlationId: idempotencyKey,
          operation: `inventory_ingest:${format}`,
          status: outcome,
          latencyMs: 12,
          errorClassification: mappingErrors[0] ?? null,
        },
      })

      await tx.auditEvent.create({
        data: {
          tenantId,
          userId,
          actorType: 'USER',
          action: 'supply.connector.inventory_ingested',
          entityType: 'inventory_update_event',
          entityId: event.id,
          payload: {
            outcome: 'allowed',
            requestId: requestId ?? null,
            connectorId: connector.id,
            format,
            ingestedRows,
            executionOutcome: outcome,
          },
        },
      })

      return {
        eventId: event.id,
        outcome,
        ingestedRows,
        validationErrors: mappingErrors,
      }
    })
  }

  async executeSupplierCancellation(tenantId: string, userId: string, input: any, requestId?: string) {
    await this.check(tenantId, userId, 'supply.contracts.manage')
    const bookingId = clean(input.bookingId)
    const idempotencyKey = clean(input.idempotencyKey)
    const reason = clean(input.reason || 'CUSTOMER_REQUEST')
    const currency = clean(input.currency).toUpperCase()
    const requestedAt = clean(input.requestedAt || new Date().toISOString())
    if (!bookingId || !idempotencyKey || !/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('Invalid cancellation execution request')
    }
    const expectedCustomerLiabilityMinor = minorBigInt(input.expectedCustomerLiabilityMinor ?? '0', 'expectedCustomerLiabilityMinor')
    const refundMinor = minorBigInt(input.refundMinor ?? '0', 'refundMinor')
    const simulatedSupplierPenaltyMinor = input.simulatedSupplierPenaltyMinor != null
      ? minorBigInt(input.simulatedSupplierPenaltyMinor, 'simulatedSupplierPenaltyMinor')
      : undefined
    if (expectedCustomerLiabilityMinor < 0n || refundMinor < 0n || (simulatedSupplierPenaltyMinor !== undefined && simulatedSupplierPenaltyMinor < 0n)) {
      throw new BadRequestException('Cancellation monetary values must be non-negative')
    }

    const booking = await this.prisma.withTenant(tenantId, tx =>
      tx.booking.findFirst({ where: { id: bookingId, tenantId }, include: { cancellations: true } }),
    )
    if (!booking) throw new NotFoundException('Booking not found')
    if (booking.currency !== currency) throw new BadRequestException('Booking currency mismatch')
    if (refundMinor > booking.totalMinor) throw new BadRequestException('Refund exceeds booking totalMinor')

    const evaluated = evaluateBedbankCancellationExecution({
      bookingReference: booking.reference,
      expectedCustomerLiabilityMinor,
      simulatedOutcome: input.simulatedSupplierOutcome,
      simulatedSupplierPenaltyMinor,
    })

    const cancellationRecord = await this.prisma.withTenant(tenantId, async tx => {
      if (input.connectorId) {
        const connector = await tx.connectorDefinition.findFirst({ where: { id: clean(input.connectorId), tenantId } })
        if (!connector) throw new NotFoundException('Connector not found')
        await tx.connectorExecution.upsert({
          where: { connectorId_correlationId: { connectorId: connector.id, correlationId: idempotencyKey } },
          update: {
            status: evaluated.executionStatus === 'CONFIRMED' ? 'SUCCEEDED' : evaluated.executionStatus === 'UNKNOWN' ? 'RETRYING' : 'FAILED',
            errorClassification: evaluated.errorClassification,
          },
          create: {
            tenantId,
            connectorId: connector.id,
            correlationId: idempotencyKey,
            operation: 'booking_cancel',
            status: evaluated.executionStatus === 'CONFIRMED' ? 'SUCCEEDED' : evaluated.executionStatus === 'UNKNOWN' ? 'RETRYING' : 'FAILED',
            latencyMs: 18,
            errorClassification: evaluated.errorClassification,
          },
        })
      }

      let cancellation: { id: string } | null = null
      if (evaluated.executionStatus === 'CONFIRMED') {
        const existingCancellation = booking.cancellations[0]
        cancellation = existingCancellation
          ? existingCancellation
          : await tx.cancellation.create({
              data: {
                bookingId: booking.id,
                reason,
                refundMinor,
              },
            })
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: 'CANCELLED' },
        })
      }

      await tx.auditEvent.create({
        data: {
          tenantId,
          userId,
          actorType: 'USER',
          action: `booking.cancellation.${evaluated.executionStatus.toLowerCase()}`,
          entityType: 'booking',
          entityId: booking.id,
          payload: {
            outcome: 'allowed',
            requestId: requestId ?? null,
            idempotencyKey,
            executionStatus: evaluated.executionStatus,
            supplierCancellationRef: evaluated.supplierCancellationRef,
            supplierPenaltyMinor: evaluated.supplierPenaltyMinor?.toString() ?? null,
            customerLiabilityMinor: expectedCustomerLiabilityMinor.toString(),
            refundMinor: refundMinor.toString(),
            discrepancyReviewRequired: evaluated.discrepancyReviewRequired,
          },
        },
      })

      return cancellation
    })

    let ledgerEntryId: string | null = null
    let refundStatus: 'NOT_DUE' | 'READY' | 'SUCCEEDED' | 'PENDING_RECONCILIATION' = 'NOT_DUE'
    let voucherNotificationIds: string[] = []

    if (evaluated.executionStatus === 'UNKNOWN' || evaluated.executionStatus === 'MANUAL_REVIEW') {
      refundStatus = 'PENDING_RECONCILIATION'
    } else if (evaluated.executionStatus === 'CONFIRMED') {
      if (refundMinor > 0n) {
        const posted = await this.ledger.postB2BLedgerAdjustment({
          tenantId,
          userId,
          requestId,
          walletId: input.walletId ? clean(input.walletId) : undefined,
          currency,
          type: 'REFUND',
          amountMinor: refundMinor,
          authorizedRefundableMinor: booking.totalMinor,
          reference: `booking:${booking.id}`,
          idempotencyKey: `cancel-refund:${idempotencyKey}`,
        })
        ledgerEntryId = posted.entry.id
        refundStatus = 'SUCCEEDED'
      }

      const vouchers = await this.notifications.dispatch({
        tenantId,
        userId,
        requestId,
        bookingId: booking.id,
        bookingReference: booking.reference,
        supplierCancellationRef: evaluated.supplierCancellationRef,
        channels: ['CLIENT_EMAIL', 'SUPPLIER_WEBHOOK'],
        currency,
        penaltyMinor: expectedCustomerLiabilityMinor,
        refundMinor,
        idempotencyKey: `cancel-voucher:${idempotencyKey}`,
      })
      voucherNotificationIds = vouchers.map(v => v.id)
    }

    return {
      bookingId: booking.id,
      cancellationId: cancellationRecord?.id ?? null,
      executionStatus: evaluated.executionStatus,
      refundStatus,
      supplierCancellationRef: evaluated.supplierCancellationRef,
      supplierPenaltyMinor: evaluated.supplierPenaltyMinor?.toString() ?? null,
      customerLiabilityMinor: expectedCustomerLiabilityMinor.toString(),
      refundMinor: refundMinor.toString(),
      currency,
      discrepancyReviewRequired: evaluated.discrepancyReviewRequired,
      ledgerEntryId,
      voucherNotificationIds,
      requestedAt,
    }
  }

  async listWalletLedgerSummaries(tenantId: string, userId: string) {
    await this.check(tenantId, userId, 'supply.contracts.read')
    const wallets = await this.prisma.withTenant(tenantId, tx =>
      tx.wallet.findMany({
        where: { tenantId },
        include: { entries: { orderBy: { immutableAt: 'desc' }, take: 50 } },
        orderBy: { currency: 'asc' },
      }),
    )
    return wallets.map(wallet => {
      const durableBalance = wallet.entries.reduce((sum, entry) => sum + entry.amountMinor, 0n)
      return {
        walletId: wallet.id,
        tenantId: wallet.tenantId,
        currency: wallet.currency,
        creditLimitMinor: wallet.creditLimit.toString(),
        durableBalanceMinor: durableBalance.toString(),
        availableCreditMinor: (wallet.creditLimit + durableBalance).toString(),
        entries: wallet.entries.map(entry => ({
          id: entry.id,
          type: entry.type,
          amountMinor: entry.amountMinor.toString(),
          currency: entry.currency,
          reference: entry.reference,
          idempotencyKey: entry.idempotencyKey,
          immutableAt: entry.immutableAt.toISOString(),
        })),
      }
    })
  }

  async postLedgerAdjustment(tenantId: string, userId: string, input: any, requestId?: string) {
    await this.check(tenantId, userId, 'supply.contracts.manage')
    const currency = clean(input.currency).toUpperCase()
    const type = clean(input.type) as 'REFUND' | 'CREDIT' | 'DEBIT' | 'RELEASE'
    if (!['REFUND', 'CREDIT', 'DEBIT', 'RELEASE'].includes(type)) {
      throw new BadRequestException('Invalid ledger adjustment type')
    }
    const amountMinor = minorBigInt(input.amountMinor, 'amountMinor')
    const authorizedRefundableMinor = input.authorizedRefundableMinor != null
      ? minorBigInt(input.authorizedRefundableMinor, 'authorizedRefundableMinor')
      : undefined

    const result = await this.ledger.postB2BLedgerAdjustment({
      tenantId,
      userId,
      requestId,
      walletId: input.walletId ? clean(input.walletId) : undefined,
      currency,
      type,
      amountMinor,
      authorizedRefundableMinor,
      reference: clean(input.reference),
      idempotencyKey: clean(input.idempotencyKey),
    })

    return {
      entryId: result.entry.id,
      walletId: result.walletId,
      type: result.entry.type,
      amountMinor: result.entry.amountMinor.toString(),
      currency: result.entry.currency,
      reference: result.entry.reference,
      availableCreditMinor: result.availableCreditMinor.toString(),
      durableBalanceMinor: result.durableBalanceMinor.toString(),
      creditLimitMinor: result.creditLimitMinor.toString(),
    }
  }

  async listCancellationVouchers(tenantId: string, userId: string, limit?: number) {
    await this.check(tenantId, userId, 'supply.contracts.read')
    return this.notifications.listDeliveries(tenantId, limit)
  }

  async dispatchCancellationVoucher(tenantId: string, userId: string, input: any, requestId?: string) {
    await this.check(tenantId, userId, 'supply.contracts.manage')
    const channels = Array.isArray(input.channels) ? (input.channels.map(String) as CancellationVoucherChannel[]) : []
    return this.notifications.dispatch({
      tenantId,
      userId,
      requestId,
      bookingId: clean(input.bookingId),
      bookingReference: clean(input.bookingReference),
      supplierCancellationRef: input.supplierCancellationRef ? clean(input.supplierCancellationRef) : null,
      channels,
      currency: clean(input.currency).toUpperCase(),
      penaltyMinor: minorBigInt(input.penaltyMinor ?? '0', 'penaltyMinor'),
      refundMinor: minorBigInt(input.refundMinor ?? '0', 'refundMinor'),
      idempotencyKey: clean(input.idempotencyKey),
    })
  }
}
