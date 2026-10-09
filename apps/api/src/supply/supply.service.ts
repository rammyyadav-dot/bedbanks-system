import { calendarDate, rateInput, availabilityInput, inputRows, uniqueRows } from './rate-input'
import { occupancyProblems } from './room-rules'
import { enabledCurrency } from '../agent/currency'
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import type { Prisma } from '@prisma/client'
import { evaluateNightSellability } from './contracted-sellability'
import { parseMarketList } from './market-rules'

const date = calendarDate
/** A contract's sales-market or nationality list: ISO-3166 alpha-2 codes, normalized to upper case. Anything else is refused rather than stored (ADR 0035). */
const marketList = (field: string, value: unknown): string[] => { const parsed = parseMarketList(value); if (parsed === null) throw new BadRequestException(`${field} must be a list of two-letter country codes`); return parsed }
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

@Injectable()
export class SupplyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}
  private async permitted(tenantId: string, userId: string, permission: string) {
    const result: any[] = await this.prisma.withTenant(tenantId, tx => tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } })) as any[]
    const keys = result.flatMap((role: any) => role.role.permissions.map((item: any) => item.permission.key))
    if (!keys.includes(permission)) throw new ForbiddenException('Insufficient permission')
  }
  /** The caller's own supply.* permission keys in the active tenant. Used only to hide controls; every endpoint still enforces its own permission. */
  async capabilities(tenantId: string, userId: string) {
    const assignments: any[] = await this.prisma.withTenant(tenantId, tx => tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } })) as any[]
    const keys = new Set<string>(assignments.flatMap((assignment: any) => assignment.role.permissions.map((item: any) => item.permission.key as string)).filter((key: string) => key.startsWith('supply.')))
    return { permissions: [...keys].sort() }
  }
  private async check(tenantId: string, userId: string, permission: string) { await this.permitted(tenantId, userId, permission) }
  private async write<T>(tenantId: string, userId: string, permission: string, action: string, entityType: string, requestId: string | undefined, work: (tx: Prisma.TransactionClient) => Promise<{ id: string; value: T }>) {
    try {
      await this.check(tenantId, userId, permission)
    } catch (error) {
      // A refused mutation leaves a denial audit event carrying this request's id, like the guard-based Admin routes (ADR 0032 evidence review).
      if (error instanceof ForbiddenException) await this.audit.record({ tenantId, userId, action: 'permission.denied', entityType: 'permission', entityId: permission, payload: { tenantId, requestId: requestId ?? null } }).catch(() => undefined)
      throw error
    }
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
  private hotelData(tenantId: string, input: any) { const name = clean(input.name); const propertyType = clean(input.propertyType); const city = clean(input.city); const countryCode = clean(input.countryCode).toUpperCase(); const timeZone = clean(input.timeZone) || 'Asia/Dubai'; const contentStatuses = ['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED']; const contentStatus = input.contentStatus ?? 'DRAFT'; if (!name || !propertyType || !city || !/^[A-Z]{2}$/.test(countryCode) || !contentStatuses.includes(contentStatus) || (input.starRating !== undefined && input.starRating !== null && (!Number.isInteger(input.starRating) || input.starRating < 1 || input.starRating > 5))) throw new BadRequestException('Invalid hotel fields'); return { tenantId, name, propertyType, starRating: input.starRating ?? null, address: input.address == null ? null : clean(input.address), city, countryCode, timeZone, contentStatus, externalRef: input.externalRef == null ? null : clean(input.externalRef) } }
  /** Publishing is a maker-checker action (ADR 0022); the generic hotel endpoints may not set or reach COMPLETE. */
  private refusePublication(): never { throw new ConflictException({ message: 'Publishing a hotel needs a second approver. Use the hotel Setup publication request.', code: 'HOTEL_PUBLICATION_REQUIRES_APPROVAL' }) }
  async createHotel(tenantId: string, userId: string, input: any, requestId?: string) { const data = this.hotelData(tenantId, input); if (data.contentStatus === 'COMPLETE') this.refusePublication(); return this.write(tenantId, userId, 'supply.hotels.manage', 'supply.hotel.created', 'hotel', requestId, async tx => { const value = await tx.hotel.create({ data }); return { id: value.id, value } }) }
  async updateHotel(tenantId: string, userId: string, hotelId: string, input: any, requestId?: string) { const allowed = ['name', 'propertyType', 'starRating', 'address', 'city', 'countryCode', 'timeZone', 'contentStatus', 'externalRef']; if (Object.keys(input).some((key) => !allowed.includes(key) || key === 'tenantId')) throw new BadRequestException('Invalid hotel fields'); const current = await this.prisma.withTenant(tenantId, tx => tx.hotel.findFirst({ where: { id: hotelId, tenantId } })); if (!current) throw new NotFoundException('Hotel not found'); const data = this.hotelData(tenantId, { ...current, ...input }); if (data.contentStatus === 'COMPLETE' && current.contentStatus !== 'COMPLETE') this.refusePublication(); return this.write(tenantId, userId, 'supply.hotels.manage', 'supply.hotel.updated', 'hotel', requestId, async tx => { const value = await tx.hotel.update({ where: { id: hotelId }, data }); if (current.contentStatus === 'COMPLETE' && data.contentStatus !== 'COMPLETE') await tx.hotelProfile.updateMany({ where: { hotelId, tenantId }, data: { approvedById: null, approvedAt: null } }); return { id: value.id, value } }) }
  private roomData(input: any) {
    const name = clean(input.name)
    const code = clean(input.code)
    const maxAdults = input.maxAdults
    const maxChildren = input.maxChildren ?? 0
    const maxOccupancy = input.maxOccupancy
    if (!name || !code || occupancyProblems(maxAdults, maxChildren, maxOccupancy).length) throw new BadRequestException('Invalid room fields')
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
  async createContract(tenantId: string, userId: string, input: any, requestId?: string) { const from = date(input.validFrom); const to = date(input.validTo); if (to < from) throw new BadRequestException('Invalid contract validity'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.created', 'contract', requestId, async tx => { const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId } }); if (!supplier) throw new BadRequestException('Supplier does not belong to tenant'); if (input.supplierHotelMappingId) { const mapping = await tx.supplierHotelMapping.findFirst({ where: { id: input.supplierHotelMappingId, tenantId, supplierId: input.supplierId, status: 'MAPPED' } }); if (!mapping) throw new BadRequestException('Invalid supplier hotel mapping') } const value = await tx.contract.create({ data: { tenantId, supplierId: input.supplierId, supplierHotelMappingId: input.supplierHotelMappingId ?? null, code: clean(input.code), validFrom: from, validTo: to, settlementCurrency: enabledCurrency(input.settlementCurrency), salesMarkets: marketList('salesMarkets', input.salesMarkets), nationalities: marketList('nationalities', input.nationalities) } }); return { id: value.id, value } }) }
  async updateContract(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) {
    return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.updated', 'contract', requestId, async tx => {
      const current = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!current) throw new NotFoundException('Contract not found')
      const validFrom = input.validFrom === undefined ? current.validFrom : date(input.validFrom), validTo = input.validTo === undefined ? current.validTo : date(input.validTo)
      if (validTo < validFrom) throw new BadRequestException('Invalid contract validity')
      const supplierId = input.supplierId ?? current.supplierId; const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId } }); if (!supplier) throw new BadRequestException('Supplier does not belong to tenant')
      const mappingId = input.supplierHotelMappingId === undefined ? current.supplierHotelMappingId : input.supplierHotelMappingId
      if (mappingId) { const mapping = await tx.supplierHotelMapping.findFirst({ where: { id: mappingId, tenantId, supplierId, status: 'MAPPED' } }); if (!mapping) throw new BadRequestException('Invalid supplier hotel mapping') }
      const value = await tx.contract.update({ where: { id: contractId }, data: { ...(input.supplierId !== undefined ? { supplierId } : {}), ...(input.supplierHotelMappingId !== undefined ? { supplierHotelMappingId: mappingId } : {}), ...(input.code !== undefined ? { code: clean(input.code) } : {}), ...(input.status !== undefined ? { status: input.status } : {}), validFrom, validTo, ...(input.settlementCurrency !== undefined ? { settlementCurrency: enabledCurrency(input.settlementCurrency) } : {}), ...(input.salesMarkets !== undefined ? { salesMarkets: marketList('salesMarkets', input.salesMarkets) } : {}), ...(input.nationalities !== undefined ? { nationalities: marketList('nationalities', input.nationalities) } : {}), ...(input.paymentPolicyRef !== undefined ? { paymentPolicyRef: input.paymentPolicyRef == null ? null : clean(input.paymentPolicyRef) } : {}) } })
      return { id: value.id, value }
    })
  }
  async contractPolicies(tenantId: string, userId: string, contractId: string) { await this.check(tenantId, userId, 'supply.contracts.read'); const value = await this.prisma.withTenant(tenantId, tx => tx.contract.findFirst({ where: { id: contractId, tenantId }, select: { id: true, cancellationPolicies: { orderBy: { daysBeforeCheckin: 'desc' } }, childPolicies: { orderBy: { minAge: 'asc' } }, leadTimeRules: true } })); if (!value) throw new NotFoundException('Contract not found'); return { ...value, cancellationPolicies: value.cancellationPolicies.map(policy => ({ ...policy, penaltyMinor: policy.penaltyMinor?.toString() ?? null })), childPolicies: value.childPolicies.map(policy => ({ ...policy, supplementMinor: policy.supplementMinor?.toString() ?? null })) } }
  async createCancellationPolicy(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) { if (!Number.isInteger(input.daysBeforeCheckin) || input.daysBeforeCheckin < 0 || ((input.penaltyPercent !== undefined) === (input.penaltyMinor !== undefined)) || (input.penaltyPercent !== undefined && (!Number.isInteger(input.penaltyPercent) || input.penaltyPercent < 0 || input.penaltyPercent > 100))) throw new BadRequestException('Invalid cancellation policy'); const penaltyMinor = input.penaltyMinor === undefined ? null : BigInt(input.penaltyMinor); if (penaltyMinor !== null && penaltyMinor < 0n) throw new BadRequestException('Invalid cancellation policy'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.cancellation_policy.created', 'cancellation_policy', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!contract) throw new NotFoundException('Contract not found'); const currency = input.currency == null ? null : enabledCurrency(input.currency); if (currency && currency.length !== 3) throw new BadRequestException('Invalid policy currency'); const value = await tx.cancellationPolicy.create({ data: { contractId, daysBeforeCheckin: input.daysBeforeCheckin, penaltyPercent: input.penaltyPercent ?? null, penaltyMinor, currency } }); return { id: value.id, value: { ...value, penaltyMinor: value.penaltyMinor?.toString() ?? null } } }) }
  async createChildPolicy(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) { if (!Number.isInteger(input.minAge) || !Number.isInteger(input.maxAge) || input.minAge < 0 || input.maxAge < input.minAge || input.maxAge > 17) throw new BadRequestException('Invalid child policy ages'); const supplementMinor = input.supplementMinor == null ? null : BigInt(input.supplementMinor); if (supplementMinor !== null && supplementMinor < 0n) throw new BadRequestException('Invalid child supplement'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.child_policy.created', 'child_policy', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!contract) throw new NotFoundException('Contract not found'); const overlap = await tx.childPolicy.findFirst({ where: { contractId, minAge: { lte: input.maxAge }, maxAge: { gte: input.minAge } } }); if (overlap) throw new BadRequestException('Child policy age ranges overlap'); const currency = input.currency == null ? null : enabledCurrency(input.currency); if (currency && currency.length !== 3) throw new BadRequestException('Invalid policy currency'); const value = await tx.childPolicy.create({ data: { contractId, minAge: input.minAge, maxAge: input.maxAge, extraBedAllowed: input.extraBedAllowed ?? false, supplementMinor, currency } }); return { id: value.id, value: { ...value, supplementMinor: value.supplementMinor?.toString() ?? null } } }) }
  async createLeadTimeRule(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) { if (!Number.isInteger(input.minLeadHours) || input.minLeadHours < 0 || (input.maxLeadDays != null && (!Number.isInteger(input.maxLeadDays) || input.maxLeadDays < 0))) throw new BadRequestException('Invalid lead-time rule'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.lead_time_rule.updated', 'booking_lead_time_rule', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!contract) throw new NotFoundException('Contract not found'); const value = await tx.bookingLeadTimeRule.upsert({ where: { contractId }, update: { minLeadHours: input.minLeadHours, maxLeadDays: input.maxLeadDays ?? null }, create: { contractId, minLeadHours: input.minLeadHours, maxLeadDays: input.maxLeadDays ?? null } }); return { id: value.id, value } }) }

  async ratePlanPortfolio(tenantId: string, userId: string, query: Record<string, unknown>) {
    await this.check(tenantId, userId, 'supply.rates.read')
    const number = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback
      if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) > max) throw new BadRequestException('Invalid pagination')
      return Number(value)
    }
    const page = number(query.page, 1, 100000), pageSize = number(query.pageSize, 25, 100)
    const scalar = (key: string) => {
      const value = query[key]
      if (value === undefined) return undefined
      if (typeof value !== 'string' || value.length > 100) throw new BadRequestException(`Invalid ${key}`)
      return value.trim() || undefined
    }
    const search = scalar('search'), status = scalar('status'), hotelId = scalar('hotelId'), supplierId = scalar('supplierId'), boardBasisId = scalar('boardBasisId'), currency = scalar('currency')
    if (status && !['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].includes(status)) throw new BadRequestException('Invalid rate plan status')
    const where: Prisma.RatePlanWhereInput = {
      tenantId, ...(status ? { status: status as 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' } : {}),
      ...(hotelId ? { roomType: { hotelId, hotel: { tenantId } } } : {}),
      ...(supplierId ? { contract: { tenantId, supplierId } } : {}), ...(boardBasisId ? { boardBasisId } : {}), ...(currency ? { currency: enabledCurrency(currency) } : {}),
      ...(search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { roomType: { hotel: { tenantId, name: { contains: search, mode: 'insensitive' } } } }, { contract: { tenantId, supplier: { displayName: { contains: search, mode: 'insensitive' } } } }] } : {}),
    }
    return this.prisma.withTenant(tenantId, async tx => {
      const total = await tx.ratePlan.count({ where })
      const items = await tx.ratePlan.findMany({ where, include: { contract: { include: { supplier: { select: { id: true, displayName: true } } } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize })
      return { items, total, page, pageSize, hasMore: page * pageSize < total }
    }, { isolationLevel: 'RepeatableRead' })
  }

  async ratePlans(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.rates.read'); return this.prisma.withTenant(tenantId, tx => tx.ratePlan.findMany({ where: { tenantId }, include: { contract: { include: { supplier: { select: { id: true, displayName: true } } } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true }, orderBy: { code: 'asc' } })) }
  async ratePlan(tenantId: string, userId: string, ratePlanId: string) { await this.check(tenantId, userId, 'supply.rates.read'); const value = await this.prisma.withTenant(tenantId, tx => tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, include: { contract: { include: { supplier: { select: { id: true, displayName: true } }, supplierHotelMapping: true } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true } })); if (!value) throw new NotFoundException('Rate plan not found'); return value }
  async createRatePlan(tenantId: string, userId: string, input: any, requestId?: string) { if (!Number.isInteger(input.occupancy) || input.occupancy < 1) throw new BadRequestException('Invalid occupancy'); return this.write(tenantId, userId, 'supply.rates.manage', 'supply.rate_plan.created', 'rate_plan', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: input.contractId, tenantId }, include: { supplierHotelMapping: true } }); const room = await tx.roomType.findFirst({ where: { id: input.roomTypeId, hotel: { tenantId } } }); const board = await tx.boardBasis.findFirst({ where: { id: input.boardBasisId, tenantId, isActive: true } }); if (!contract || !room || !board) throw new BadRequestException('Invalid rate plan relationship'); if (contract.supplierHotelMapping && contract.supplierHotelMapping.hotelId !== room.hotelId) throw new BadRequestException('Contract and room hotel mismatch'); const value = await tx.ratePlan.create({ data: { tenantId, contractId: input.contractId, roomTypeId: input.roomTypeId, boardBasisId: input.boardBasisId, code: clean(input.code), occupancy: input.occupancy, currency: enabledCurrency(input.currency), refundable: input.refundable ?? true, taxesIncluded: input.taxesIncluded ?? false, feesIncluded: input.feesIncluded ?? false, minStay: input.minStay ?? 1, maxStay: input.maxStay ?? null, releaseDays: input.releaseDays ?? 0 } }); return { id: value.id, value } }) }
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
      const currency = input.currency === undefined ? current.currency : enabledCurrency(input.currency); if (currency.length !== 3) throw new BadRequestException('Invalid currency')
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
    const result = await this.editCalendar(tenantId, userId, { availability: inputRows(input.rows, 'availability') }, requestId)
    return result.availability
  }

  async bulkDailyRates(tenantId: string, userId: string, input: any, requestId?: string) {
    const result = await this.editCalendar(tenantId, userId, { rates: inputRows(input.rows, 'daily rate') }, requestId)
    return result.rates
  }

  async upsertDailyRate(tenantId: string, userId: string, input: any, requestId?: string) {
    return (await this.editCalendar(tenantId, userId, { rates: [input] }, requestId)).rates[0]
  }

  async upsertAvailability(tenantId: string, userId: string, input: any, requestId?: string) {
    return (await this.editCalendar(tenantId, userId, { availability: [input] }, requestId)).availability[0]
  }

  /** One transaction for the entire calendar edit. Preview performs the same validation without writes.
   * The strict runtime grant contract remains authoritative; this does not elevate the connection. */
  async editCalendar(tenantId: string, userId: string, input: { rates?: unknown; availability?: unknown }, requestId?: string, preview = false, requireVersions = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid calendar edit')
    const rates = input.rates === undefined ? [] : inputRows(input.rates, 'daily rate').map(rateInput)
    const availability = input.availability === undefined ? [] : inputRows(input.availability, 'availability').map(availabilityInput)
    if (rates.length + availability.length === 0 || rates.length + availability.length > 366) throw new BadRequestException('Provide 1 to 366 total calendar changes')
    uniqueRows(rates); uniqueRows(availability)
    if (requireVersions && [...rates, ...availability].some(row => row.expectedUpdatedAt === undefined)) throw new BadRequestException('Every cell requires expectedUpdatedAt (null for a new cell)')
    for (const permission of [...(rates.length ? ['supply.rates.manage'] : []), ...(availability.length ? ['supply.availability.manage'] : [])]) {
      try { await this.check(tenantId, userId, permission) } catch (error) {
        if (error instanceof ForbiddenException) await this.audit.record({ tenantId, userId, action: 'permission.denied', entityType: 'permission', entityId: permission, payload: { tenantId, requestId: requestId ?? null } }).catch(() => undefined)
        throw error
      }
    }
    try {
      return await this.prisma.withTenant(tenantId, async tx => {
        const ids = [...new Set([...rates, ...availability].map(row => row.ratePlanId))].sort()
        const plans = await tx.ratePlan.findMany({ where: { tenantId, id: { in: ids } }, include: { contract: true } })
        if (plans.length !== ids.length) throw new BadRequestException('Rate plan unavailable in this tenant')
        const checkVersion = (expected: string | null | undefined, current: { updatedAt: Date } | null) => {
          if (expected !== undefined && expected !== (current?.updatedAt.toISOString() ?? null)) throw new ConflictException({ code: 'CALENDAR_CHANGED', message: 'A cell changed since it was loaded. Reload and review your changes.' })
        }
        const rateChanges = []
        const availabilityChanges = []
        for (const row of rates) {
          const plan = plans.find(plan => plan.id === row.ratePlanId)!
          if (plan.currency !== row.currency || plan.contract.settlementCurrency !== row.currency || plan.occupancy !== row.occupancy) throw new BadRequestException('Rate currency or occupancy does not match the plan and contract')
          if (row.stayDate < plan.contract.validFrom || row.stayDate > plan.contract.validTo) throw new BadRequestException('Rate date is outside the contract')
          const before = await tx.dailyRate.findUnique({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: row.ratePlanId, stayDate: row.stayDate, occupancy: row.occupancy } } })
          checkVersion(row.expectedUpdatedAt, before)
          rateChanges.push({ row, before })
        }
        for (const row of availability) {
          const plan = plans.find(plan => plan.id === row.ratePlanId)!
          if (row.stayDate < plan.contract.validFrom || row.stayDate > plan.contract.validTo) throw new BadRequestException('Availability date is outside the contract')
          const before = await tx.dailyAvailability.findUnique({ where: { ratePlanId_stayDate: { ratePlanId: row.ratePlanId, stayDate: row.stayDate } } })
          checkVersion(row.expectedUpdatedAt, before)
          if (before && row.allotment < before.sold + before.held) throw new BadRequestException('Allotment cannot be below committed inventory')
          // A pooled plan has a single physical stock authority. Its local restrictions may change, not its ignored allotment.
          if (plan.inventoryPoolId && (!before || row.allotment !== before.allotment)) throw new BadRequestException('Change shared stock through the inventory pool capacity workflow')
          availabilityChanges.push({ row, before })
        }
        const changes = [
          ...rateChanges.map(({ row, before }) => ({ kind: 'rate', ratePlanId: row.ratePlanId, stayDate: row.stayDate.toISOString().slice(0, 10), before: before ? { amountMinor: before.amountMinor.toString(), amountBasis: before.amountBasis, currency: before.currency } : null, after: { amountMinor: row.amountMinor.toString(), amountBasis: row.amountBasis, currency: row.currency } })),
          ...availabilityChanges.map(({ row, before }) => ({ kind: 'availability', ratePlanId: row.ratePlanId, stayDate: row.stayDate.toISOString().slice(0, 10), before: before ? { allotment: before.allotment, stopSell: before.stopSell, minStay: before.minStay } : null, after: { allotment: row.allotment, stopSell: row.stopSell ?? before?.stopSell ?? false, minStay: row.minStay ?? before?.minStay ?? 1 } })),
        ]
        const savedRates = []
        const savedAvailability = []
        if (!preview) {
          for (const { row, before } of rateChanges) {
            const values = { ratePlanId: row.ratePlanId, stayDate: row.stayDate, occupancy: row.occupancy, amountMinor: row.amountMinor, amountBasis: row.amountBasis, currency: row.currency }
            const saved = await tx.dailyRate.upsert({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: row.ratePlanId, stayDate: row.stayDate, occupancy: row.occupancy } }, create: { tenantId, ...values }, update: { amountMinor: row.amountMinor, amountBasis: row.amountBasis, currency: row.currency, updatedAt: new Date(Math.max(Date.now(), (before?.updatedAt.getTime() ?? 0) + 1)) } })
            savedRates.push({ ...saved, amountMinor: saved.amountMinor.toString() })
            await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.daily_rate.updated', entityType: 'daily_rate', entityId: saved.id, payload: { requestId: requestId ?? null, before: before ? { amountMinor: before.amountMinor.toString(), amountBasis: before.amountBasis } : null, after: { amountMinor: row.amountMinor.toString(), amountBasis: row.amountBasis } } } })
          }
          for (const { row, before } of availabilityChanges) {
            const data = { allotment: row.allotment, stopSell: row.stopSell ?? before?.stopSell ?? false, minStay: row.minStay ?? before?.minStay ?? 1 }
            const saved = await tx.dailyAvailability.upsert({ where: { ratePlanId_stayDate: { ratePlanId: row.ratePlanId, stayDate: row.stayDate } }, create: { tenantId, ratePlanId: row.ratePlanId, stayDate: row.stayDate, ...data }, update: { ...data, updatedAt: new Date(Math.max(Date.now(), (before?.updatedAt.getTime() ?? 0) + 1)) } })
            savedAvailability.push(saved)
            await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.availability.updated', entityType: 'daily_availability', entityId: saved.id, payload: { requestId: requestId ?? null, before: before ? { allotment: before.allotment, stopSell: before.stopSell, minStay: before.minStay } : null, after: data } } })
          }
        }
        return { atomic: true, preview, affectedCells: changes.length, changes, rates: savedRates, availability: savedAvailability }
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2034' || (error as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'CALENDAR_CHANGED', message: 'Concurrent calendar change. Reload and review before retrying.' })
      throw error
    }
  }

  /**
   * Per-night sellability diagnostic. `reasons` are stable backend codes; clients render them verbatim.
   * Optional stay context (`checkInDate` + `nights`) additionally evaluates minimum stay, maximum stay and release days.
   */
  async sellability(tenantId: string, userId: string, input: any) {
    await this.check(tenantId, userId, 'supply.rates.read')
    const stayDate = date(input.stayDate)
    const hasStay = input.checkInDate !== undefined || input.nights !== undefined
    if (hasStay && (typeof input.checkInDate !== 'string' || !Number.isInteger(input.nights) || input.nights < 1 || input.nights > 366)) throw new BadRequestException('checkInDate and a positive integer nights are required together')
    const checkIn = hasStay ? date(input.checkInDate) : null
    const plan = await this.prisma.withTenant(tenantId, tx => tx.ratePlan.findFirst({ where: { id: input.ratePlanId, tenantId }, include: { roomType: { include: { hotel: true } }, boardBasis: true, contract: { include: { supplier: true, supplierHotelMapping: true } }, dailyRates: { where: { tenantId, stayDate, occupancy: input.occupancy } }, availability: { where: { tenantId, stayDate } } } }))
    const roomMapping = plan?.contract.supplierHotelMapping
      ? await this.prisma.withTenant(tenantId, tx => tx.supplierRoomMapping.findFirst({ where: { tenantId, supplierHotelMappingId: plan.contract.supplierHotelMappingId!, roomTypeId: plan.roomTypeId, status: 'MAPPED' } }))
      : null
    const reasons: string[] = evaluateNightSellability(plan, { stayDate, occupancy: input.occupancy })
    // Non-blocking: the night checks pass, but agent search only lists hotels whose content is COMPLETE.
    const warnings: string[] = plan && plan.roomType.hotel.contentStatus !== 'COMPLETE' && plan.roomType.hotel.contentStatus !== 'SUSPENDED' ? ['HOTEL_CONTENT_NOT_COMPLETE'] : []
    if (plan) {
      const hotelMapping = plan.contract.supplierHotelMapping
      if (hotelMapping && hotelMapping.hotelId === plan.roomType.hotelId && hotelMapping.status === 'MAPPED' && !roomMapping) reasons.push('ROOM_MAPPING_UNAPPROVED')
      const availability = plan.availability[0]
      if (checkIn) {
        const requiredMinStay = Math.max(plan.minStay, availability && stayDate.getTime() === checkIn.getTime() ? availability.minStay : 1)
        if (input.nights < requiredMinStay) reasons.push('MIN_STAY_NOT_MET')
        if (plan.maxStay != null && input.nights > plan.maxStay) reasons.push('MAX_STAY_EXCEEDED')
        const today = date(new Intl.DateTimeFormat('en-CA', { timeZone: plan.roomType.hotel.timeZone || 'UTC' }).format(new Date()))
        if (Math.round((checkIn.getTime() - today.getTime()) / 86_400_000) < plan.releaseDays) reasons.push('RELEASE_DAYS_NOT_MET')
      }
    }
    return { eligible: reasons.length === 0, status: reasons.length === 0 ? 'ELIGIBLE_FOR_FUTURE_SEARCH' : 'NOT_ELIGIBLE', reasons, warnings }
  }
}
