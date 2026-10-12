import { assertHotelIdentityAvailable } from '../hotel-setup/hotel-identity'
import { assertRoomActivationAllowed, lockHotelSetup, touchSetup } from '../hotel-setup/hotel-setup-shared'
import { isIanaTimeZone, assessCompleteness, regressions } from '../hotel-setup/hotel-setup-rules'
import { calendarDate, rateInput, availabilityInput, inputRows, uniqueRows } from './rate-input'
import { occupancyProblems } from './room-rules'
import { enabledCurrency } from '../agent/currency'
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import type { Prisma } from '@prisma/client'
import { evaluateNightSellability } from './contracted-sellability'
import { codesOutsideContract, parseMarketList, parseMarketRules } from './market-rules'
import { RatePlanOpsDatabase } from './rate-plan-ops-database'
import { RatePlanCloneDatabase } from './rate-plan-clone-database'
import { isValidPolicySetName, rulesForPlan } from './cancellation-rules'
import { resolvePlanTerms, type PlanTerms } from './rate-plan-terms'
import { assessRatePlanActivation, cloneDraftFields, transitionTarget, type RatePlanAction } from './rate-plan-activation'
import { deriveRatePlanCapabilities } from './rate-plan-capabilities'
import { activationApprovalMode } from './rate-plan-approval-mode'
import { planFingerprint } from './rate-plan-fingerprint'
import { EXTRA_ADULT_BAND, validateGuestPriceLines } from './guest-pricing'
import { buildCalendarImport, scanReferences, type ExistingAvailability, type ExistingRate, type ImportPlan } from './calendar-import'

const date = calendarDate
/** A contract's sales-market or nationality list: ISO-3166 alpha-2 codes, normalized to upper case. Anything else is refused rather than stored (ADR 0035). */
const marketList = (field: string, value: unknown): string[] => { const parsed = parseMarketList(value); if (parsed === null) throw new BadRequestException(`${field} must be a list of two-letter country codes`); return parsed }
/** Lifecycle status is written only by the activate/suspend routes, which run the readiness evaluator. Any other route naming `status` is refused, never ignored. */
const refuseStatusField = (input: unknown) => {
  if (input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'status')) throw new BadRequestException({ code: 'RATE_PLAN_STATUS_VIA_LIFECYCLE_ONLY', message: 'Rate plan status cannot be set here. Use the activate or suspend routes.' })
}
/** What a second person approved, passed from the approval service into the single lifecycle transaction (ADR 0057, S5). */
export interface ApprovedActivation { approvalId: string; requestedById: string; approvedById: string; fingerprint: string; asOf: string }
const MAX_APPROVAL_RATE_ROWS = 5000
const RATE_PLAN_EDITABLE = new Set(['contractId', 'roomTypeId', 'boardBasisId', 'code', 'occupancy', 'currency', 'refundable', 'taxesIncluded', 'feesIncluded', 'minStay', 'maxStay', 'releaseDays', 'validFrom', 'validTo', 'paymentType', 'cancellationPolicySet', 'salesMarkets', 'nationalities'])
/** Fields whose change can make an ACTIVE plan unsellable-by-contract; an edit to any of them is re-checked against readiness before it commits. */
const READINESS_FIELDS = ['contractId', 'roomTypeId', 'boardBasisId', 'occupancy', 'currency', 'refundable', 'minStay', 'maxStay', 'validFrom', 'validTo', 'cancellationPolicySet', 'salesMarkets', 'nationalities'] as const
const refuseUnknownFields = (input: unknown) => {
  const unknown = Object.keys(input && typeof input === 'object' ? input : {}).filter(key => !RATE_PLAN_EDITABLE.has(key))
  if (unknown.length) throw new BadRequestException({ code: 'RATE_PLAN_UNKNOWN_FIELD', message: `Unsupported rate plan field(s): ${unknown.join(', ')}` })
}
const dayOf = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
/** Validated sale window and payment type of a plan, resolved against the contract term. A refusal is a typed 400 and nothing is written. */
const planTermsOrThrow = (input: Record<string, unknown>, current: PlanTerms, contract: { validFrom: Date; validTo: Date }): PlanTerms => {
  const result = resolvePlanTerms(input, current, { validFrom: dayOf(contract.validFrom)!, validTo: dayOf(contract.validTo)! })
  if (!result.ok) throw new BadRequestException({ code: result.code, message: result.message })
  return result.terms
}
/** A named cancellation set must exist on the plan's contract and only a refundable plan may carry one. Null uses the contract default. Typed 400, nothing written. */
const cancellationSetOrThrow = async (tx: Prisma.TransactionClient, contractId: string, refundable: boolean, requested: unknown): Promise<string | null> => {
  if (requested === null || requested === undefined) return null
  if (!isValidPolicySetName(requested)) throw new BadRequestException({ code: 'RATE_PLAN_CANCELLATION_SET_INVALID', message: 'cancellationPolicySet must be 1-80 characters: letters, digits, space, dot, dash or underscore, starting with a letter or digit.' })
  if (!refundable) throw new BadRequestException({ code: 'RATE_PLAN_CANCELLATION_SET_ON_NON_REFUNDABLE', message: 'A non-refundable plan carries no cancellation rule set.' })
  const rules = await tx.cancellationPolicy.findMany({ where: { contractId }, select: { policySet: true } })
  if (rulesForPlan({ cancellationPolicySet: requested }, rules).missing) throw new BadRequestException({ code: 'RATE_PLAN_CANCELLATION_SET_UNKNOWN', message: `The contract has no cancellation rules in a set named "${requested}". Add them first.` })
  return requested
}
/**
 * Plan-level buyer markets and nationalities (ADR 0057, S3). A key left out keeps the stored list; an explicit null or [] clears it.
 * A plan list can only narrow a restricted contract: any code outside the contract's own non-empty list is refused, because it could never sell.
 */
const planMarketsOrThrow = (input: Record<string, unknown>, current: { salesMarkets: unknown; nationalities: unknown }, contract: { salesMarkets?: unknown; nationalities?: unknown }): { salesMarkets: string[]; nationalities: string[] } => {
  const contractRules = parseMarketRules(contract)
  const resolve = (key: 'salesMarkets' | 'nationalities'): string[] => {
    const parsed = parseMarketList(Object.prototype.hasOwnProperty.call(input, key) ? input[key] : current[key])
    if (parsed === null) throw new BadRequestException({ code: 'RATE_PLAN_MARKET_LIST_INVALID', message: `${key} must be a list of two-letter country codes.` })
    const outside = codesOutsideContract(parsed, contractRules[key] ?? [])
    if (outside.length) throw new BadRequestException({ code: 'RATE_PLAN_MARKET_OUTSIDE_CONTRACT', message: `${key} ${outside.join(', ')} is not in the contract's own list, so the plan could never sell to it. A plan can only narrow its contract.` })
    return parsed
  }
  return { salesMarkets: resolve('salesMarkets'), nationalities: resolve('nationalities') }
}
const dateOrNull = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null)
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

@Injectable()
export class SupplyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, @Optional() private readonly ratePlanOps?: RatePlanOpsDatabase, @Optional() private readonly ratePlanClone?: RatePlanCloneDatabase) {}
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
  private async write<T>(tenantId: string, userId: string, permission: string, action: string, entityType: string, requestId: string | undefined, work: (tx: Prisma.TransactionClient) => Promise<{ id: string; value: T }>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; lifecycleRole?: boolean; cloneRole?: boolean }) {
    try {
      await this.check(tenantId, userId, permission)
    } catch (error) {
      // A refused mutation leaves a denial audit event carrying this request's id, like the guard-based Admin routes (ADR 0032 evidence review).
      if (error instanceof ForbiddenException) await this.audit.record({ tenantId, userId, action: 'permission.denied', entityType: 'permission', entityId: permission, payload: { tenantId, requestId: requestId ?? null } }).catch(() => undefined)
      throw error
    }
    // Lifecycle transitions use the narrow role when one is configured (ADR 0041 Amendment 2); its audit grant is INSERT-only, so no row is read back.
    const viaOps = options?.lifecycleRole === true && this.ratePlanOps?.configured() === true
    // Cloning inserts a row, which the lifecycle role must not do; it uses its own DRAFT-only role (ADR 0057, S8). Same audit rule: INSERT-only, no row read back.
    const viaClone = options?.cloneRole === true && this.ratePlanClone?.configured() === true
    const viaRole = viaOps || viaClone
    const run = async (tx: Prisma.TransactionClient) => {
      const result = await work(tx)
      const data = { tenantId, userId, actorType: 'USER' as const, action, entityType, entityId: result.id, payload: { outcome: 'allowed', requestId: requestId ?? null } }
      if (viaRole) await tx.auditEvent.createMany({ data: [data] }); else await tx.auditEvent.create({ data })
      return result.value
    }
    return viaOps ? this.ratePlanOps!.withTenant(tenantId, run) : viaClone ? this.ratePlanClone!.withTenant(tenantId, run) : this.prisma.withTenant(tenantId, run, options && { isolationLevel: options.isolationLevel })
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
  private hotelData(tenantId: string, input: any) { const name = clean(input.name); const propertyType = clean(input.propertyType); const city = clean(input.city); const countryCode = clean(input.countryCode).toUpperCase(); const timeZone = clean(input.timeZone) || 'Asia/Dubai'; const contentStatuses = ['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED', 'ARCHIVED']; const contentStatus = input.contentStatus ?? 'DRAFT'; if (!name || name.length > 160 || !propertyType || propertyType.length > 120 || !city || city.length > 120 || !isIanaTimeZone(timeZone) || !/^[A-Z]{2}$/.test(countryCode) || !contentStatuses.includes(contentStatus) || (input.starRating !== undefined && input.starRating !== null && (!Number.isInteger(input.starRating) || input.starRating < 1 || input.starRating > 5))) throw new BadRequestException('Invalid hotel fields'); return { tenantId, name, propertyType, starRating: input.starRating ?? null, address: input.address == null ? null : clean(input.address), city, countryCode, timeZone, contentStatus, externalRef: input.externalRef == null ? null : clean(input.externalRef) } }
  /** Publishing is a maker-checker action (ADR 0022); the generic hotel endpoints may not set or reach COMPLETE. */
  private refusePublication(): never { throw new ConflictException({ message: 'Publishing a hotel needs a second approver. Use the hotel Setup publication request.', code: 'HOTEL_PUBLICATION_REQUIRES_APPROVAL' }) }
  async createHotel(tenantId: string, userId: string, input: any, requestId?: string) {
    const allowed = ['name', 'propertyType', 'starRating', 'address', 'city', 'countryCode', 'timeZone', 'contentStatus', 'externalRef']
    if (Object.keys(input).some(k => !allowed.includes(k))) throw new BadRequestException('Invalid hotel fields')
    const data = this.hotelData(tenantId, input)
    if (data.contentStatus === 'COMPLETE') this.refusePublication()
    if (data.contentStatus === 'ARCHIVED') throw new BadRequestException('Create a draft before archiving it through Hotel Setup')
    try {
      return await this.write(tenantId, userId, 'supply.hotels.manage', 'supply.hotel.created', 'hotel', requestId, async tx => {
        await assertHotelIdentityAvailable(tx, tenantId, data)
        const value = await tx.hotel.create({ data })
        return { id: value.id, value }
      })
    } catch (error) { this.hotelWriteConflict(error); throw error }
  }

  private hotelWriteConflict(error: unknown): void {
    const code = (error as { code?: string }).code
    if (code === 'P2002') throw new ConflictException({ code: 'HOTEL_EXTERNAL_REF_CONFLICT', message: 'This hotel reference is already in use in the tenant.' })
    if (code === 'P2025') throw new ConflictException({ code: 'HOTEL_SETUP_STALE', message: 'The hotel changed during this edit. Reload and review the latest profile.' })
  }

  async updateHotel(tenantId: string, userId: string, hotelId: string, input: any, requestId?: string) {
    const allowed = ['name', 'propertyType', 'starRating', 'address', 'city', 'countryCode', 'timeZone', 'contentStatus', 'externalRef']
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestException('Invalid hotel fields')
    const current = await this.prisma.withTenant(tenantId, tx => tx.hotel.findFirst({ where: { id: hotelId, tenantId } }))
    if (!current) throw new NotFoundException('Hotel not found')
    const data = this.hotelData(tenantId, { ...current, ...input })
    if (data.contentStatus === 'COMPLETE' && current.contentStatus !== 'COMPLETE') this.refusePublication()
    try {
      return await this.write(tenantId, userId, 'supply.hotels.manage', 'supply.hotel.updated', 'hotel', requestId, async tx => {
        await lockHotelSetup(tx, tenantId, hotelId)
        if (data.contentStatus !== current.contentStatus && [data.contentStatus, current.contentStatus].includes('ARCHIVED')) {
          throw new ConflictException({ code: 'HOTEL_STATUS_REQUIRES_SETUP', message: 'Change hotel lifecycle through Hotel Setup with a concurrency token and reason.' })
        }
        await assertHotelIdentityAvailable(tx, tenantId, data, hotelId)
        if (current.contentStatus === 'COMPLETE' && data.contentStatus === 'COMPLETE') {
          const profile = await tx.hotelProfile.findFirst({ where: { hotelId, tenantId } })
          const base = {
            ...current, latitude: current.latitude?.toString() ?? null, longitude: current.longitude?.toString() ?? null,
            starVerified: Boolean(profile?.starVerifiedAt), shortDescription: profile?.shortDescription ?? null,
            checkInTime: profile?.checkInTime ?? null, checkOutTime: profile?.checkOutTime ?? null,
            contacts: (profile?.contacts ?? {}) as import('@bedbanks/contracts').HotelContacts,
            activeRooms: await tx.roomType.count({ where: { hotelId, isActive: true } }),
          }
          const lost = regressions(assessCompleteness(base), assessCompleteness({ ...base, ...data, starVerified: data.starRating === current.starRating && base.starVerified }))
          if (lost.length) throw new ConflictException({ code: 'HOTEL_PUBLICATION_REQUIREMENT_LOST', message: 'A published hotel cannot lose a publication requirement. Use Hotel Setup.' })
        }
        const value = await tx.hotel.update({ where: { id: hotelId, updatedAt: current.updatedAt }, data })
        if (current.starRating !== data.starRating) await tx.hotelProfile.updateMany({ where: { hotelId, tenantId }, data: { starVerifiedAt: null, starVerifiedById: null } })
        if (current.contentStatus === 'COMPLETE' && data.contentStatus !== 'COMPLETE') await tx.hotelProfile.updateMany({ where: { hotelId, tenantId }, data: { approvedById: null, approvedAt: null } })
        return { id: value.id, value }
      })
    } catch (error) { this.hotelWriteConflict(error); throw error }
  }
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
    return this.write(tenantId, userId, 'supply.rooms.manage', 'supply.room.created', 'room_type', requestId, async tx => { await lockHotelSetup(tx, tenantId, hotelId); await this.tenantHotel(tx, tenantId, hotelId); const value = await tx.roomType.create({ data: { hotelId, ...data } }); await touchSetup(tx, tenantId, hotelId, userId, new Date()); return { id: value.id, value } })
  }
  async updateRoom(tenantId: string, userId: string, hotelId: string, roomId: string, input: any, requestId?: string) {
    const allowed = ['name', 'code', 'maxAdults', 'maxChildren', 'maxOccupancy', 'beddingMetadata', 'isActive']
    if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.includes(key) || key === 'hotelId' || key === 'tenantId')) throw new BadRequestException('Invalid room fields')
    return this.write(tenantId, userId, 'supply.rooms.manage', 'supply.room.updated', 'room_type', requestId, async tx => {
      await lockHotelSetup(tx, tenantId, hotelId)
      const hotel = await this.tenantHotel(tx, tenantId, hotelId)
      const current = await tx.roomType.findFirst({ where: { id: roomId, hotelId } })
      if (!current) throw new NotFoundException('Room not found')
      const data = this.roomData({ ...current, ...input })
      if (data.isActive !== current.isActive) await assertRoomActivationAllowed(tx, hotel, current.id, data.isActive)
      const value = await tx.roomType.update({ where: { id: roomId }, data })
      await touchSetup(tx, tenantId, hotelId, userId, new Date())
      return { id: value.id, value }
    })
  }
  async roomTypes(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.rooms.read'); return this.prisma.withTenant(tenantId, tx => tx.roomType.findMany({ where: { hotel: { tenantId } }, orderBy: { name: 'asc' } })) }
  async createRoomType(tenantId: string, userId: string, input: any, requestId?: string) {
    if (!Number.isInteger(input.maxAdults) || !Number.isInteger(input.maxChildren ?? 0) || !Number.isInteger(input.maxOccupancy) || input.maxAdults < 1 || (input.maxChildren ?? 0) < 0 || input.maxOccupancy < input.maxAdults + (input.maxChildren ?? 0)) throw new BadRequestException('Invalid occupancy')
    return this.write(tenantId, userId, 'supply.rooms.manage', 'supply.room.created', 'room_type', requestId, async tx => {
      const hotel = await tx.hotel.findFirst({ where: { id: input.hotelId, tenantId } })
      if (!hotel) throw new BadRequestException('Hotel does not belong to tenant')
      await lockHotelSetup(tx, tenantId, hotel.id)
      const value = await tx.roomType.create({ data: { hotelId: hotel.id, name: clean(input.name), code: clean(input.code), maxAdults: input.maxAdults, maxChildren: input.maxChildren ?? 0, maxOccupancy: input.maxOccupancy, beddingMetadata: input.beddingMetadata ?? {} } })
      await touchSetup(tx, tenantId, hotel.id, userId, new Date())
      return { id: value.id, value }
    })
  }
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
  async createCancellationPolicy(tenantId: string, userId: string, contractId: string, input: any, requestId?: string) { if (!Number.isInteger(input.daysBeforeCheckin) || input.daysBeforeCheckin < 0 || ((input.penaltyPercent !== undefined) === (input.penaltyMinor !== undefined)) || (input.penaltyPercent !== undefined && (!Number.isInteger(input.penaltyPercent) || input.penaltyPercent < 0 || input.penaltyPercent > 100))) throw new BadRequestException('Invalid cancellation policy'); if (input.policySet !== undefined && input.policySet !== null && !isValidPolicySetName(input.policySet)) throw new BadRequestException({ code: 'CANCELLATION_POLICY_SET_INVALID', message: 'policySet must be 1-80 characters: letters, digits, space, dot, dash or underscore, starting with a letter or digit.' }); const penaltyMinor = input.penaltyMinor === undefined ? null : BigInt(input.penaltyMinor); if (penaltyMinor !== null && penaltyMinor < 0n) throw new BadRequestException('Invalid cancellation policy'); return this.write(tenantId, userId, 'supply.contracts.manage', 'supply.contract.cancellation_policy.created', 'cancellation_policy', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId } }); if (!contract) throw new NotFoundException('Contract not found'); const currency = input.currency == null ? null : enabledCurrency(input.currency); if (currency && currency.length !== 3) throw new BadRequestException('Invalid policy currency'); const value = await tx.cancellationPolicy.create({ data: { contractId, policySet: input.policySet ?? null, daysBeforeCheckin: input.daysBeforeCheckin, penaltyPercent: input.penaltyPercent ?? null, penaltyMinor, currency } }); return { id: value.id, value: { ...value, penaltyMinor: value.penaltyMinor?.toString() ?? null } } }) }
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
      // Counts ignore the status filter so the toolbar can show the whole split for the current hotel/search scope.
      const { status: _status, ...scope } = where
      const grouped = await tx.ratePlan.groupBy({ by: ['status'], where: scope, _count: { _all: true } })
      const statusCounts = { DRAFT: 0, ACTIVE: 0, SUSPENDED: 0, EXPIRED: 0 }
      for (const row of grouped) statusCounts[row.status] = row._count._all
      return { items, total, page, pageSize, hasMore: page * pageSize < total, statusCounts }
    }, { isolationLevel: 'RepeatableRead' })
  }

  async ratePlans(tenantId: string, userId: string) { await this.check(tenantId, userId, 'supply.rates.read'); return this.prisma.withTenant(tenantId, tx => tx.ratePlan.findMany({ where: { tenantId }, include: { contract: { include: { supplier: { select: { id: true, displayName: true } } } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true }, orderBy: { code: 'asc' } })) }
  async ratePlan(tenantId: string, userId: string, ratePlanId: string) { await this.check(tenantId, userId, 'supply.rates.read'); const value = await this.prisma.withTenant(tenantId, tx => tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, include: { contract: { include: { supplier: { select: { id: true, displayName: true } }, supplierHotelMapping: true } }, roomType: { include: { hotel: { select: { id: true, name: true } } } }, boardBasis: true } })); if (!value) throw new NotFoundException('Rate plan not found'); return value }
  async createRatePlan(tenantId: string, userId: string, input: any, requestId?: string) { refuseStatusField(input); refuseUnknownFields(input); if (!Number.isInteger(input.occupancy) || input.occupancy < 1) throw new BadRequestException('Invalid occupancy'); return this.write(tenantId, userId, 'supply.rates.manage', 'supply.rate_plan.created', 'rate_plan', requestId, async tx => { const contract = await tx.contract.findFirst({ where: { id: input.contractId, tenantId }, include: { supplierHotelMapping: true } }); const room = await tx.roomType.findFirst({ where: { id: input.roomTypeId, hotel: { tenantId } } }); const board = await tx.boardBasis.findFirst({ where: { id: input.boardBasisId, tenantId, isActive: true } }); if (!contract || !room || !board) throw new BadRequestException('Invalid rate plan relationship'); if (contract.supplierHotelMapping && contract.supplierHotelMapping.hotelId !== room.hotelId) throw new BadRequestException('Contract and room hotel mismatch'); const terms = planTermsOrThrow(input, { validFrom: null, validTo: null, paymentType: null }, contract); const cancellationPolicySet = await cancellationSetOrThrow(tx, input.contractId, input.refundable ?? true, input.cancellationPolicySet); const markets = planMarketsOrThrow(input, { salesMarkets: [], nationalities: [] }, contract); const value = await tx.ratePlan.create({ data: { tenantId, contractId: input.contractId, roomTypeId: input.roomTypeId, boardBasisId: input.boardBasisId, code: clean(input.code), occupancy: input.occupancy, currency: enabledCurrency(input.currency), refundable: input.refundable ?? true, taxesIncluded: input.taxesIncluded ?? false, feesIncluded: input.feesIncluded ?? false, minStay: input.minStay ?? 1, maxStay: input.maxStay ?? null, releaseDays: input.releaseDays ?? 0, validFrom: dateOrNull(terms.validFrom), validTo: dateOrNull(terms.validTo), paymentType: terms.paymentType, cancellationPolicySet, salesMarkets: markets.salesMarkets, nationalities: markets.nationalities } }); return { id: value.id, value } }) }
  async updateRatePlan(tenantId: string, userId: string, ratePlanId: string, input: any, requestId?: string) {
    // Validated before any permission lookup, transaction or write, so a mixed body is refused whole.
    refuseStatusField(input); refuseUnknownFields(input)
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
      const terms = planTermsOrThrow(input, { validFrom: dayOf(current.validFrom), validTo: dayOf(current.validTo), paymentType: current.paymentType }, contract)
      const markets = planMarketsOrThrow(input, current, contract)
      const refundableNext = input.refundable ?? current.refundable
      const cancellationPolicySet = await cancellationSetOrThrow(tx, contractId, refundableNext, input.cancellationPolicySet === undefined ? current.cancellationPolicySet : input.cancellationPolicySet)
      const before = current.status === 'ACTIVE' && READINESS_FIELDS.some(field => input[field] !== undefined) ? (await this.activationReadiness(tx, tenantId, ratePlanId)).readiness.checks : null
      const value = await tx.ratePlan.update({ where: { id: ratePlanId }, data: { contractId, roomTypeId, boardBasisId, ...(input.code !== undefined ? { code: clean(input.code) } : {}), occupancy, currency, ...(input.refundable !== undefined ? { refundable: input.refundable } : {}), ...(input.taxesIncluded !== undefined ? { taxesIncluded: input.taxesIncluded } : {}), ...(input.feesIncluded !== undefined ? { feesIncluded: input.feesIncluded } : {}), minStay, maxStay, releaseDays, validFrom: dateOrNull(terms.validFrom), validTo: dateOrNull(terms.validTo), paymentType: terms.paymentType, cancellationPolicySet, salesMarkets: markets.salesMarkets, nationalities: markets.nationalities } })
      // An ACTIVE plan must not be edited into a state activation would refuse: any readiness check that passed before this edit and fails after it refuses the edit.
      // Checks that were already failing are not this edit's doing and do not block it.
      if (before) {
        const { readiness } = await this.activationReadiness(tx, tenantId, ratePlanId)
        const passedBefore = new Set(before.filter(item => item.ok).map(item => item.code))
        const broken = readiness.checks.filter(item => !item.ok && item.code !== 'STATUS_ALLOWED' && passedBefore.has(item.code))
        if (broken.length) throw new ConflictException({ code: 'RATE_PLAN_NOT_READY', message: 'This edit would leave an active rate plan not ready for sale. Suspend it first.', details: broken })
      }
      return { id: value.id, value }
    })
  }

  /** Loads plain facts for the activation evaluator inside the caller's tenant transaction. Nothing is inferred: a missing relation is reported by the checklist. */
  private async activationReadiness(tx: Prisma.TransactionClient, tenantId: string, ratePlanId: string) {
    const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, include: { roomType: { include: { hotel: { select: { id: true, timeZone: true } } } }, boardBasis: true, contract: { include: { supplierHotelMapping: true, cancellationPolicies: { select: { policySet: true } } } }, guestPrices: true } })
    if (!plan) throw new NotFoundException('Rate plan not found')
    const timeZone = plan.roomType.hotel.timeZone
    const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const todayDate = new Date(`${today}T00:00:00Z`)
    const [rates, availability] = await Promise.all([
      tx.dailyRate.findMany({ where: { tenantId, ratePlanId, occupancy: plan.occupancy, stayDate: { gte: todayDate } }, select: { stayDate: true, amountBasis: true, currency: true, amountMinor: true }, orderBy: { stayDate: 'asc' }, take: 1500 }),
      tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId, stayDate: { gte: todayDate } }, select: { stayDate: true }, orderBy: { stayDate: 'asc' }, take: 1500 }),
    ])
    const day = (value: Date) => value.toISOString().slice(0, 10)
    const readiness = assessRatePlanActivation({
      today,
      plan: { status: plan.status, currency: plan.currency, occupancy: plan.occupancy, refundable: plan.refundable, minStay: plan.minStay, maxStay: plan.maxStay, inventoryPoolId: plan.inventoryPoolId, validFrom: dayOf(plan.validFrom), validTo: dayOf(plan.validTo), cancellationPolicySet: plan.cancellationPolicySet, markets: parseMarketRules(plan) },
      room: { hotelId: plan.roomType.hotelId, maxOccupancy: plan.roomType.maxOccupancy, isActive: plan.roomType.isActive },
      board: { isActive: plan.boardBasis.isActive },
      contract: { status: plan.contract.status, validFrom: day(plan.contract.validFrom), validTo: day(plan.contract.validTo), settlementCurrency: plan.contract.settlementCurrency, mappedHotelId: plan.contract.supplierHotelMapping?.hotelId ?? null, cancellationPolicyCount: rulesForPlan(plan, plan.contract.cancellationPolicies).rules.length, markets: parseMarketRules(plan.contract) },
      rates: rates.map(row => ({ stayDate: day(row.stayDate), amountBasis: row.amountBasis, currency: row.currency, amountMinor: row.amountMinor })),
      guestPrices: plan.guestPrices.map(line => ({ kind: line.kind, minAge: line.minAge, maxAge: line.maxAge, amountMinor: line.amountMinor, basis: line.amountBasis, currency: line.currency })),
      availabilityDates: availability.map(row => day(row.stayDate)),
    })
    return { plan, readiness, today }
  }
  async ratePlanReadiness(tenantId: string, userId: string, ratePlanId: string) {
    await this.check(tenantId, userId, 'supply.rates.read')
    return this.prisma.withTenant(tenantId, async tx => { const { plan, readiness } = await this.activationReadiness(tx, tenantId, ratePlanId); return { ratePlanId, status: plan.status, updatedAt: plan.updatedAt.toISOString(), ...readiness } })
  }
  /**
   * Which lifecycle actions can work here (ADR 0041 Amendment 3), from the runtime identity's real privileges. Read-only catalogue functions; no tenant data is touched.
   * A failed probe propagates as an error: the Admin treats "unknown" as unavailable rather than offering a control that may fail.
   */
  async ratePlanCapabilities(tenantId: string, userId: string) {
    await this.check(tenantId, userId, 'supply.rates.read')
    const [grants] = await this.prisma.$queryRaw<Array<{ can_update_status: boolean; can_insert: boolean }>>`SELECT has_column_privilege(current_user, '"RatePlan"', 'status', 'UPDATE') AS can_update_status, has_table_privilege(current_user, '"RatePlan"', 'INSERT') AS can_insert`
    return deriveRatePlanCapabilities({ opsRoleConfigured: this.ratePlanOps?.configured() === true, runtimeCanUpdateStatus: grants?.can_update_status === true, runtimeCanInsert: grants?.can_insert === true, cloneRoleConfigured: this.ratePlanClone?.configured() === true, activationApproval: activationApprovalMode() })
  }
  /** Activate or suspend. Activation is refused unless the readiness checklist is fully green; both transitions are version-checked and audited with before/after status. */
  async transitionRatePlan(tenantId: string, userId: string, ratePlanId: string, action: RatePlanAction, input: any, requestId?: string) {
    if (action !== 'activate' && action !== 'suspend') throw new BadRequestException('Unknown rate plan action')
    const expected = typeof input?.expectedUpdatedAt === 'string' ? new Date(input.expectedUpdatedAt) : null
    if (!expected || Number.isNaN(expected.getTime())) throw new BadRequestException('expectedUpdatedAt is required')
    const reason = clean(input?.reason)
    if (action === 'suspend' && reason.length < 3) throw new BadRequestException('A reason is required to suspend a rate plan')
    if (action === 'activate' && activationApprovalMode() === 'required') {
      // Authorization first, so an unauthorised caller learns nothing about the policy. Suspension only removes exposure and stays single-actor.
      await this.check(tenantId, userId, 'supply.rates.manage')
      throw new ConflictException({ code: 'RATE_PLAN_APPROVAL_REQUIRED', message: 'Activating a rate plan needs a second person. File an activation request; a different user with rate management permission approves it.' })
    }
    return this.runTransition(tenantId, userId, ratePlanId, action, expected, reason, requestId, undefined)
  }

  /** Activation after a second person approved exactly this content (ADR 0057, S5). Called only by the approval service, inside the single-use execute claim. */
  activateApproved(tenantId: string, userId: string, ratePlanId: string, expected: Date, approval: ApprovedActivation, requestId?: string) {
    return this.runTransition(tenantId, userId, ratePlanId, 'activate', expected, '', requestId, approval)
  }

  private async runTransition(tenantId: string, userId: string, ratePlanId: string, action: RatePlanAction, expected: Date, reason: string, requestId: string | undefined, approval: ApprovedActivation | undefined) {
    try { return await this.transitionRatePlanTx(tenantId, userId, ratePlanId, action, expected, reason, requestId, approval) } catch (error) {
      // A concurrent writer touching the same facts aborts a serializable transaction; report it as the same retryable conflict as a stale version.
      if ((error as { code?: string }).code === 'P2034') throw new ConflictException({ code: 'RATE_PLAN_CHANGED', message: 'The rate plan or its commercial facts changed during the update. Reload and retry.' })
      throw error
    }
  }

  /** Permission gate for the approval service: authentication is not authorization. */
  assertPermission(tenantId: string, userId: string, permission: 'supply.rates.read' | 'supply.rates.manage') { return this.check(tenantId, userId, permission) }

  /** The content an approver is shown: plan terms and every rate row of the plan occupancy from `asOf`. Capped; an oversized plan is refused rather than hashed partially. */
  private async contentFingerprint(tx: Prisma.TransactionClient, tenantId: string, plan: Awaited<ReturnType<SupplyService['activationReadiness']>>['plan'], asOf: string): Promise<string> {
    const rows = await tx.dailyRate.findMany({ where: { tenantId, ratePlanId: plan.id, occupancy: plan.occupancy, stayDate: { gte: new Date(`${asOf}T00:00:00Z`) } }, select: { stayDate: true, occupancy: true, amountMinor: true, amountBasis: true, currency: true }, orderBy: { stayDate: 'asc' }, take: MAX_APPROVAL_RATE_ROWS + 1 })
    if (rows.length > MAX_APPROVAL_RATE_ROWS) throw new BadRequestException({ code: 'RATE_PLAN_TOO_MANY_RATES', message: `Approval covers at most ${MAX_APPROVAL_RATE_ROWS} dated rates; split the plan or end its sale window.` })
    const guestLines = await tx.ratePlanGuestPrice.findMany({ where: { tenantId, ratePlanId: plan.id }, select: { kind: true, minAge: true, maxAge: true, amountMinor: true, amountBasis: true, currency: true } })
    return planFingerprint(plan, rows, asOf, guestLines)
  }

  /** Read-only: readiness plus the content fingerprint, for requesting an approval. */
  async approvalFacts(tenantId: string, ratePlanId: string) {
    return this.prisma.withTenant(tenantId, async tx => {
      const { plan, readiness, today } = await this.activationReadiness(tx, tenantId, ratePlanId)
      return { plan, readiness, asOf: today, fingerprint: await this.contentFingerprint(tx, tenantId, plan, today) }
    })
  }

  private transitionRatePlanTx(tenantId: string, userId: string, ratePlanId: string, action: RatePlanAction, expected: Date, reason: string, requestId?: string, approval?: ApprovedActivation) {
    return this.write(tenantId, userId, 'supply.rates.manage', action === 'activate' ? 'supply.rate_plan.activated' : 'supply.rate_plan.suspended', 'rate_plan', requestId, async tx => {
      const { plan, readiness } = await this.activationReadiness(tx, tenantId, ratePlanId)
      if (plan.updatedAt.getTime() !== expected.getTime()) throw new ConflictException({ code: 'RATE_PLAN_CHANGED', message: 'The rate plan changed since it was loaded. Reload and review before retrying.' })
      const target = transitionTarget(action, plan.status)
      if (!target) throw new ConflictException({ code: 'RATE_PLAN_TRANSITION_NOT_ALLOWED', message: `A ${plan.status} rate plan cannot be ${action === 'activate' ? 'activated' : 'suspended'}.` })
      if (action === 'activate' && !readiness.ready) throw new ConflictException({ code: 'RATE_PLAN_NOT_READY', message: 'Activation readiness checks failed.', details: readiness.checks.filter(item => !item.ok) })
      // The approval covers exactly the content that was reviewed. Any price, term or night changed since then voids it, even if readiness still passes.
      if (action === 'activate' && approval && await this.contentFingerprint(tx, tenantId, plan, approval.asOf) !== approval.fingerprint) {
        throw new ConflictException({ code: 'RATE_PLAN_CHANGED_SINCE_APPROVAL', message: 'The rate plan terms or rates changed after the approval. File a new request so the approver reviews what will go live.' })
      }
      const changed = await tx.ratePlan.updateMany({ where: { id: ratePlanId, tenantId, status: plan.status, updatedAt: plan.updatedAt }, data: { status: target } })
      if (changed.count !== 1) throw new ConflictException({ code: 'RATE_PLAN_CHANGED', message: 'The rate plan changed during the update. Reload and retry.' })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'supply.rate_plan.status_changed', entityType: 'rate_plan', entityId: ratePlanId, payload: { requestId: requestId ?? null, before: { status: plan.status }, after: { status: target }, reason: reason || null, ...(action === 'activate' ? { activation: approval ? { mode: 'approved', approvalId: approval.approvalId, requestedById: approval.requestedById, approvedById: approval.approvedById } : { mode: 'off' } } : {}) } }] })
      const value = await tx.ratePlan.findFirstOrThrow({ where: { id: ratePlanId, tenantId } })
      return { id: value.id, value }
    }, { isolationLevel: 'Serializable', lifecycleRole: true })
  }
  /** Child and extra-adult lines of a plan (ADR 0057, S6). `supply.rates.read`; 404 for another tenant's plan. */
  async guestPrices(tenantId: string, userId: string, ratePlanId: string) {
    await this.check(tenantId, userId, 'supply.rates.read')
    const plan = await this.prisma.withTenant(tenantId, tx => tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { id: true, updatedAt: true, currency: true, occupancy: true, guestPrices: { orderBy: [{ kind: 'asc' }, { minAge: 'asc' }] } } }))
    if (!plan) throw new NotFoundException('Rate plan not found')
    return { ratePlanId: plan.id, updatedAt: plan.updatedAt.toISOString(), currency: plan.currency, occupancy: plan.occupancy, lines: plan.guestPrices.map(line => ({ kind: line.kind, minAge: line.minAge, maxAge: line.maxAge, amountMinor: line.amountMinor.toString(), amountBasis: line.amountBasis, currency: line.currency })) }
  }

  /**
   * Replaces all of a plan's guest price lines atomically (ADR 0057, S6). Version-checked against the plan, validated as a whole (every problem reported),
   * audited with the amounts before and after. The plan version moves, so an activation approval filed on the old prices is voided.
   */
  async replaceGuestPrices(tenantId: string, userId: string, ratePlanId: string, input: any, requestId?: string) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid guest price request')
    const expected = typeof input.expectedUpdatedAt === 'string' ? new Date(input.expectedUpdatedAt) : null
    if (!expected || Number.isNaN(expected.getTime())) throw new BadRequestException('expectedUpdatedAt is required')
    if (!Array.isArray(input.lines) || input.lines.length > 40) throw new BadRequestException('Provide at most 40 guest price lines')
    const lines = input.lines.map((raw: any) => {
      const kind = raw?.kind
      const amount = typeof raw?.amountMinor === 'string' && /^[0-9]{1,19}$/.test(raw.amountMinor) ? BigInt(raw.amountMinor) : null
      return { kind, ...(kind === 'EXTRA_ADULT' ? EXTRA_ADULT_BAND : { minAge: raw?.minAge, maxAge: raw?.maxAge }), amountMinor: amount, basis: raw?.amountBasis, currency: typeof raw?.currency === 'string' ? raw.currency.toUpperCase() : undefined }
    })
    return this.write(tenantId, userId, 'supply.rates.manage', 'supply.rate_plan.guest_prices_replaced', 'rate_plan', requestId, async tx => {
      const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { id: true, updatedAt: true, currency: true, guestPrices: { select: { kind: true, minAge: true, maxAge: true, amountMinor: true, amountBasis: true } } } })
      if (!plan) throw new NotFoundException('Rate plan not found')
      if (plan.updatedAt.getTime() !== expected.getTime()) throw new ConflictException({ code: 'RATE_PLAN_CHANGED', message: 'The rate plan changed since it was loaded. Reload and review before retrying.' })
      const issues = validateGuestPriceLines(lines, plan.currency)
      if (issues.length) throw new BadRequestException({ code: issues[0]!.code, message: issues[0]!.message, details: issues })
      await tx.ratePlanGuestPrice.deleteMany({ where: { tenantId, ratePlanId } })
      if (lines.length) await tx.ratePlanGuestPrice.createMany({ data: lines.map((line: any) => ({ tenantId, ratePlanId, kind: line.kind, minAge: line.minAge, maxAge: line.maxAge, amountMinor: line.amountMinor, amountBasis: line.basis, currency: line.currency })) })
      // The plan version moves with its prices: an approval or a stale editor bound to the old version is refused.
      await tx.ratePlan.update({ where: { id: ratePlanId }, data: { updatedAt: new Date(Math.max(Date.now(), plan.updatedAt.getTime() + 1)) } })
      const shape = (rows: Array<{ kind: string; minAge: number; maxAge: number; amountMinor: bigint | null; amountBasis?: string | null; basis?: string }>) => rows.map(r => ({ kind: r.kind, minAge: r.minAge, maxAge: r.maxAge, amountMinor: r.amountMinor?.toString() ?? null, basis: r.amountBasis ?? r.basis ?? null }))
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.rate_plan.guest_prices_changed', entityType: 'rate_plan', entityId: ratePlanId, payload: { requestId: requestId ?? null, before: shape(plan.guestPrices), after: shape(lines) } } })
      return { id: ratePlanId, value: { ratePlanId } }
    }).then(() => this.guestPrices(tenantId, userId, ratePlanId))
  }

  /** Copies the commercial shape into a new DRAFT. Rates, availability, pool membership and status are never copied. */
  async cloneRatePlan(tenantId: string, userId: string, ratePlanId: string, input: any, requestId?: string) {
    const code = clean(input?.code)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$/.test(code)) throw new BadRequestException('Rate plan code must be 2-40 letters, digits, dot, dash or underscore')
    return this.write(tenantId, userId, 'supply.rates.manage', 'supply.rate_plan.cloned', 'rate_plan', requestId, async tx => {
      const source = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId } })
      if (!source) throw new NotFoundException('Rate plan not found')
      const roomTypeId = typeof input?.roomTypeId === 'string' && input.roomTypeId ? input.roomTypeId : source.roomTypeId
      const [sourceRoom, targetRoom, contract] = await Promise.all([
        tx.roomType.findFirst({ where: { id: source.roomTypeId, hotel: { tenantId } } }),
        tx.roomType.findFirst({ where: { id: roomTypeId, hotel: { tenantId } } }),
        tx.contract.findFirst({ where: { id: source.contractId, tenantId }, include: { supplierHotelMapping: true } }),
      ])
      if (!sourceRoom || !targetRoom || !contract) throw new BadRequestException('Invalid rate plan relationship')
      if (targetRoom.hotelId !== sourceRoom.hotelId) throw new BadRequestException('A clone must stay within the same hotel')
      if (source.occupancy > targetRoom.maxOccupancy) throw new BadRequestException('Occupancy exceeds the target room capacity')
      if (await tx.ratePlan.findFirst({ where: { contractId: source.contractId, code }, select: { id: true } })) throw new ConflictException({ code: 'RATE_PLAN_CODE_EXISTS', message: 'That rate plan code already exists on this contract.' })
      const value = await tx.ratePlan.create({ data: { tenantId, ...cloneDraftFields(source, { code, roomTypeId }), salesMarkets: source.salesMarkets as Prisma.InputJsonValue, nationalities: source.nationalities as Prisma.InputJsonValue } })
      return { id: value.id, value }
    }, { cloneRole: true }).catch((error: { code?: string }) => {
      // Two clones racing for the same code: the unique key decides, and the loser gets the same typed answer as the pre-check.
      if (error?.code === 'P2002') throw new ConflictException({ code: 'RATE_PLAN_CODE_EXISTS', message: 'That rate plan code already exists on this contract.' })
      throw error
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
  /**
   * CSV import preview (ADR 0057, S7). Read-only. Parses and validates the file per row, loads only the cells it refers to for their current versions,
   * and runs the accepted cells through the same preview as every other calendar edit. Applying is `calendar/apply` with the returned `edit`.
   */
  async previewCalendarImport(tenantId: string, userId: string, input: { hotelId?: unknown; csv?: unknown }, requestId?: string) {
    if (typeof input?.hotelId !== 'string' || !input.hotelId.trim() || input.hotelId.length > 100) throw new BadRequestException('hotelId is required')
    if (typeof input.csv !== 'string') throw new BadRequestException('csv must be text')
    await this.check(tenantId, userId, 'supply.rates.read')
    const hotelId = input.hotelId
    const refs = scanReferences(input.csv)
    const loaded = await this.prisma.withTenant(tenantId, async tx => {
      const hotel = await tx.hotel.findFirst({ where: { id: hotelId, tenantId }, select: { id: true } })
      if (!hotel) throw new NotFoundException('Hotel not found')
      const plans = await tx.ratePlan.findMany({ where: { tenantId, roomType: { hotelId, hotel: { tenantId } } }, select: { id: true, code: true, currency: true, occupancy: true, inventoryPoolId: true, status: true, contract: { select: { validFrom: true, validTo: true } } }, orderBy: { id: 'asc' }, take: 2001 })
      if (plans.length > 2000) throw new BadRequestException('This hotel has too many rate plans to import against in one file; contact support.')
      const referenced = plans.filter(plan => refs.planKeys.includes(plan.id) || refs.planKeys.includes(plan.code))
      const planIds = referenced.map(plan => plan.id)
      const stayDates = refs.dates.map(day => new Date(`${day}T00:00:00.000Z`))
      const [rates, availability] = planIds.length && stayDates.length
        ? await Promise.all([
          tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { in: stayDates } }, select: { ratePlanId: true, stayDate: true, occupancy: true, updatedAt: true } }),
          tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { in: stayDates } }, select: { ratePlanId: true, stayDate: true, allotment: true, sold: true, held: true, stopSell: true, minStay: true, updatedAt: true } }),
        ])
        : [[], []]
      return { plans, rates, availability }
    })
    const day = (value: Date) => value.toISOString().slice(0, 10)
    const importPlans: ImportPlan[] = loaded.plans.map(plan => ({ id: plan.id, code: plan.code, currency: plan.currency, occupancy: plan.occupancy, inventoryPoolId: plan.inventoryPoolId, expired: plan.status === 'EXPIRED', contractValidFrom: day(plan.contract.validFrom), contractValidTo: day(plan.contract.validTo) }))
    const plansByCode = new Map<string, ImportPlan[]>()
    for (const plan of importPlans) plansByCode.set(plan.code, [...(plansByCode.get(plan.code) ?? []), plan])
    const rateIndex = new Map<string, ExistingRate>(loaded.rates.map(row => [`${row.ratePlanId}|${day(row.stayDate)}|${row.occupancy}`, { updatedAt: row.updatedAt.toISOString() }]))
    const availabilityIndex = new Map<string, ExistingAvailability>(loaded.availability.map(row => [`${row.ratePlanId}|${day(row.stayDate)}`, { updatedAt: row.updatedAt.toISOString(), allotment: row.allotment, sold: row.sold, held: row.held, stopSell: row.stopSell, minStay: row.minStay }]))
    const built = buildCalendarImport(input.csv, { plansByCode, plansById: new Map(importPlans.map(plan => [plan.id, plan])), rate: (planId, date, occupancy) => rateIndex.get(`${planId}|${date}|${occupancy}`) ?? null, availability: (planId, date) => availabilityIndex.get(`${planId}|${date}`) ?? null })
    const cells = built.rates.length + built.availability.length
    const edit = cells > 0 && built.fatal.length === 0 ? { ...(built.rates.length ? { rates: built.rates } : {}), ...(built.availability.length ? { availability: built.availability } : {}) } : null
    // The authoritative preview: same validation, permissions and stale-cell rules as every other calendar edit. It writes nothing.
    const preview = edit ? await this.editCalendar(tenantId, userId, edit, requestId, true, true) : null
    return { ok: built.ok && built.fatal.length === 0, fatal: built.fatal, errors: built.errors, warnings: built.warnings, truncatedErrors: built.truncatedErrors, stats: built.stats, edit, preview }
  }

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
