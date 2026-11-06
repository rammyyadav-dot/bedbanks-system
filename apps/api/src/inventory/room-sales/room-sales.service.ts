import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type {
  AllocationBoard, AllocationEditRequest, AllocationEditResult, AllocationNightView, RoomSalesCalendar, RoomSalesCell, RoomSalesCommitRequest,
  RoomSalesCommitResult, RoomSalesMode, RoomSalesPreview, RoomSalesPreviewRequest, SalesEligibilityRequest, SalesEligibilityResult, SalesHistoryEntry,
  SupplierStayDecision, SupplierStayRequestBody, SupplierStayRequestView,
} from '@bedbanks/contracts'
import { PrismaService } from '../../database/prisma.service'
import { idParam } from '../../admin-operations/query-params'
import { dayInZone } from '../../hotel-setup/quick-update-rules'
import {
  WEEKDAYS, addDays, availableInventory, effectiveOutcome, idempotencyDecision, inclusiveDates, isIsoDate, planSalesBatch, postReleaseMode,
  releasedContracted, resolveRoomSales, salesFingerprint, scopeKey, simulatedDistribution, stayNights, weekdayOf,
} from './engine'
import { SimulatedSalesDistributionAdapter, type SalesDistributionAdapter } from './distribution'

type Tx = Prisma.TransactionClient
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`)
const day = (d: Date) => d.toISOString().slice(0, 10)
const NOTE = 'Saved in fBeds. Channel delivery stays pending until the simulated adapter acknowledges it. There is no live supplier connection.'

@Injectable()
export class RoomSalesService {
  clock: () => Date = () => new Date()
  private readonly distribution: SalesDistributionAdapter = new SimulatedSalesDistributionAdapter()
  constructor(private readonly prisma: PrismaService) {}

  private async hotel(tx: Tx, tenantId: string, hotelIdRaw: string) {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true, name: true, timeZone: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel
  }

  private window(query: { from?: unknown; days?: unknown }, today: string) {
    const from = typeof query.from === 'string' && query.from !== '' ? query.from : today
    if (!isIsoDate(from)) throw new BadRequestException('Invalid from')
    const days = query.days === undefined || query.days === '' ? 28 : Number(query.days)
    if (![7, 14, 28].includes(days)) throw new BadRequestException('Days must be 7, 14 or 28')
    const dates = Array.from({ length: days }, (_, i) => addDays(from, i))
    return { from: dates[0], to: dates[dates.length - 1], days, dates }
  }

  private scopeOf(query: { poolId?: unknown; ratePlanId?: unknown; channel?: unknown; market?: unknown; contractId?: unknown }) {
    const read = (name: string, value: unknown, pattern: RegExp) => {
      if (value === undefined || value === '' || value === null) return null
      if (typeof value !== 'string' || !pattern.test(value)) throw new BadRequestException(`Invalid ${name}`)
      return value
    }
    return {
      poolId: read('poolId', query.poolId, /^[A-Za-z0-9_.:-]{1,40}$/),
      ratePlanId: read('ratePlanId', query.ratePlanId, /^[A-Za-z0-9_.:-]{1,40}$/),
      channel: read('channel', query.channel, /^[A-Z0-9_]{1,40}$/),
      market: read('market', query.market, /^[A-Z]{2}$/),
      contractId: read('contractId', query.contractId, /^[A-Za-z0-9_.:-]{1,40}$/),
    }
  }

  private async canReopenBroad(tx: Tx, tenantId: string, userId: string) {
    const roles = await tx.userRole.findMany({
      where: { userId, tenantId, role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })
    return roles.some((role) => role.role.permissions.some((item) => item.permission.key === 'supply.hotels.manage'))
  }

  private async names(tx: Tx, tenantId: string, ids: string[]) {
    if (ids.length === 0) return new Map<string, string>()
    const users = await tx.user.findMany({ where: { id: { in: ids }, memberships: { some: { tenantId } } }, select: { id: true, name: true } })
    return new Map(users.map((user) => [user.id, user.name?.trim() || 'Team member']))
  }

  async calendar(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<RoomSalesCalendar> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const today = dayInZone(this.clock(), hotel.timeZone)
      const w = this.window(query, today)
      const scope = this.scopeOf(query)
      const rooms = await tx.roomType.findMany({ where: { hotelId: hotel.id, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, maxAdults: true, maxChildren: true, maxOccupancy: true } })
      const plans = await tx.ratePlan.findMany({
        where: { tenantId, roomType: { hotelId: hotel.id } },
        select: { id: true, code: true, roomTypeId: true, inventoryPoolId: true, contractId: true, contract: { select: { code: true, allotmentType: true, supplier: { select: { id: true, displayName: true } } } }, boardBasis: { select: { code: true } }, roomType: { select: { name: true } } },
        orderBy: { code: 'asc' },
      })
      const pools = await tx.inventoryPool.findMany({ where: { tenantId, hotelId: hotel.id, status: 'ACTIVE' }, select: { id: true, name: true, supplierId: true, supplier: { select: { displayName: true } } }, orderBy: { name: 'asc' } })
      const rules = await tx.roomSalesRule.findMany({ where: { tenantId, hotelId: hotel.id, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } } })
      const poolIds = pools.map((pool) => pool.id)
      const days = poolIds.length === 0 ? [] : await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: { in: poolIds }, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } } })
      const allocations = poolIds.length === 0 ? [] : await tx.poolNightAllocation.findMany({ where: { tenantId, hotelId: hotel.id, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } } })
      const planIds = plans.map((plan) => plan.id)
      const rates = planIds.length === 0 ? [] : await tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } }, select: { ratePlanId: true, stayDate: true, amountMinor: true } })
      const jobs = await tx.salesDistributionJob.findMany({ where: { tenantId, hotelId: hotel.id }, orderBy: { createdAt: 'desc' }, take: 8 })
      const actors = await this.names(tx, tenantId, [...new Set(rules.map((rule) => rule.actorId))])
      const channels = [...new Set(rules.map((rule) => rule.channelKey).filter(Boolean))].sort()
      const markets = [...new Set(rules.map((rule) => rule.marketKey).filter(Boolean))].sort()
      const views = rules.map((rule) => ({
        roomTypeId: rule.roomTypeId, stayDate: day(rule.stayDate), poolKey: rule.poolKey, planKey: rule.planKey, channelKey: rule.channelKey, marketKey: rule.marketKey, contractKey: rule.contractKey,
        mode: rule.mode as RoomSalesMode, salesCap: rule.salesCap, consumesInventory: rule.consumesInventory, overrideExpiresAt: rule.overrideExpiresAt ? rule.overrideExpiresAt.toISOString() : null,
      }))
      const cells: RoomSalesCell[] = []
      for (const room of rooms) for (const date of w.dates) {
        const exact = rules.find((rule) => rule.roomTypeId === room.id && day(rule.stayDate) === date && rule.poolKey === scopeKey(scope.poolId) && rule.planKey === scopeKey(scope.ratePlanId) && rule.channelKey === scopeKey(scope.channel) && rule.marketKey === scopeKey(scope.market) && rule.contractKey === scopeKey(scope.contractId))
        const inScope = plans.filter((plan) => plan.roomTypeId === room.id && (!scope.poolId || plan.inventoryPoolId === scope.poolId) && (!scope.ratePlanId || plan.id === scope.ratePlanId) && (!scope.contractId || plan.contractId === scope.contractId))
        const pool = scope.poolId ? pools.find((item) => item.id === scope.poolId) ?? null : pools.find((item) => inScope.some((plan) => plan.inventoryPoolId === item.id)) ?? null
        const stock = pool ? days.find((row) => row.poolId === pool.id && day(row.stayDate) === date) : null
        const allocation = pool ? allocations.find((row) => row.poolId === pool.id && day(row.stayDate) === date) : null
        const consumed = stock ? stock.sold + stock.held : null
        const resolved = resolveRoomSales({ rules: views, roomTypeId: room.id, ratePlanId: scope.ratePlanId ?? inScope[0]?.id ?? '', poolId: pool?.id ?? scope.poolId, contractId: scope.contractId, stayDate: date, channel: scope.channel, market: scope.market, now: this.clock(), consumed })
        const nightRates = rates.filter((rate) => day(rate.stayDate) === date && inScope.some((plan) => plan.id === rate.ratePlanId))
        const verified = nightRates.some((rate) => rate.amountMinor > 0n)
        const quarantined = nightRates.some((rate) => rate.amountMinor <= 0n) && !verified
        const remaining = stock && allocation
          ? availableInventory({ contracted: allocation.contracted, approvedAdjustment: allocation.approvedAdjustment, confirmed: stock.sold, activeHolds: stock.held, blocked: allocation.blockedQuantity, blockedAlreadyExcluded: allocation.blockedExcludedFromAllocation })
          : stock ? stock.capacity - stock.sold - stock.held : null
        const effect = effectiveOutcome({ resolved, verifiedRate: verified, quarantinedRate: quarantined, inventoryRemaining: remaining, legacyMode: null, legacyStop: false, roomsRequested: 1 })
        const intended = allocation && stock ? allocation.contracted + allocation.approvedAdjustment - (allocation.blockedExcludedFromAllocation ? 0 : allocation.blockedQuantity) : null
        cells.push({
          roomTypeId: room.id, stayDate: date, configuredMode: exact ? exact.mode as RoomSalesMode : null, version: exact?.version ?? null, effectiveOutcome: effect.outcome, effectiveReasons: effect.reasons,
          salesCap: exact?.salesCap ?? null, capRemaining: resolved.capRemaining, overCap: resolved.overCap, consumesInventory: exact?.consumesInventory ?? true,
          scopeLabel: this.scopeLabel(scope, pool?.name ?? null), source: exact?.source ?? null, actorName: exact ? actors.get(exact.actorId) ?? 'Team member' : null, updatedAt: exact ? exact.updatedAt.toISOString() : null, reason: exact?.reason ?? null,
          inventory: pool ? {
            poolId: pool.id, poolName: pool.name, contracted: allocation?.contracted ?? stock?.capacity ?? null, approvedAdjustment: allocation?.approvedAdjustment ?? 0, confirmed: stock?.sold ?? null, activeHolds: stock?.held ?? null,
            blocked: allocation?.blockedQuantity ?? 0, blockedExcludedFromAllocation: allocation?.blockedExcludedFromAllocation ?? false, remaining, consistent: intended === null || !stock ? null : stock.capacity === Math.max(intended, stock.sold + stock.held),
            overCommitment: remaining !== null && remaining < 0, releaseCutoff: allocation?.releaseCutoffDays === null || allocation?.releaseCutoffDays === undefined ? null : `${allocation.releaseCutoffDays} days before arrival at ${allocation.releaseTimeLocal ?? '00:00'}`,
            postReleasePolicy: allocation ? allocation.postReleasePolicy as AllocationNightView['postReleasePolicy'] : null,
          } : null,
          rateState: quarantined ? 'QUARANTINED' : verified ? 'VERIFIED' : 'MISSING',
          distributionState: exact ? (jobs.find((job) => job.batchId === exact.batchId)?.status ?? null) : null,
        })
      }
      const contracts = [...new Map(plans.map((plan) => [plan.contractId, { id: plan.contractId, code: plan.contract.code, allotmentType: plan.contract.allotmentType, supplierName: plan.contract.supplier.displayName }])).values()]
      return {
        hotelId: hotel.id, hotelName: hotel.name, timeZone: hotel.timeZone, hotelToday: today, generatedAt: this.clock().toISOString(), window: { from: w.from, to: w.to, days: w.days }, scope, scopeLabel: this.scopeLabel(scope, pools.find((pool) => pool.id === scope.poolId)?.name ?? null),
        contracts, pools: pools.map((pool) => ({ id: pool.id, name: pool.name, supplierId: pool.supplierId, supplierName: pool.supplier.displayName })),
        ratePlans: plans.map((plan) => ({ id: plan.id, code: plan.code, roomTypeId: plan.roomTypeId, roomName: plan.roomType.name, poolId: plan.inventoryPoolId, contractId: plan.contractId, contractCode: plan.contract.code, boardCode: plan.boardBasis.code.trim() })),
        channels, markets, rooms, dates: w.dates, cells,
        jobs: jobs.map((job) => ({ id: job.id, state: job.status, attempts: job.attempts, lastError: job.lastError, simulated: true as const, label: simulatedDistribution.label, createdAt: job.createdAt.toISOString() })),
        notes: [NOTE, 'A Free Sale cell is not a booking confirmation. Stop Sale does not cancel existing bookings.', 'Stay dates in this grid are inclusive. A booking search remains check-in inclusive and check-out exclusive.'],
      }
    })
  }

  private scopeLabel(scope: { poolId: string | null; ratePlanId: string | null; channel: string | null; market: string | null; contractId: string | null }, poolName: string | null) {
    return [poolName ?? (scope.poolId ? 'Selected pool' : 'All pools'), scope.contractId ? 'Selected contract' : 'All contracts', scope.ratePlanId ? 'Selected rate plan' : 'All rate plans', scope.channel ?? 'All channels', scope.market ?? 'All markets'].join(' · ')
  }

  private async prepare(tx: Tx, tenantId: string, userId: string, hotelId: string, body: RoomSalesPreviewRequest) {
    const hotel = await this.hotel(tx, tenantId, hotelId)
    const scope = this.scopeOf(body)
    const rooms = await tx.roomType.findMany({ where: { hotelId: hotel.id, isActive: true }, select: { id: true, name: true } })
    const roomTypeIds = body.allRoomTypes ? rooms.map((room) => room.id) : (body.roomTypeIds ?? []).filter((id) => rooms.some((room) => room.id === id))
    const contract = scope.contractId ? await tx.contract.findFirst({ where: { id: scope.contractId, tenantId }, select: { id: true, allotmentType: true, supplierHotelMapping: { select: { hotelId: true } } } }) : null
    if (scope.contractId && (!contract || contract.supplierHotelMapping?.hotelId !== hotel.id)) throw new NotFoundException('Contract not found')
    if (scope.poolId) {
      const pool = await tx.inventoryPool.findFirst({ where: { id: scope.poolId, tenantId, hotelId: hotel.id }, select: { id: true } })
      if (!pool) throw new NotFoundException('Pool not found')
    }
    const dates = inclusiveDates(body.from, body.to) ?? []
    const targets = body.cells?.filter((cell) => roomTypeIds.includes(cell.roomTypeId) && isIsoDate(cell.stayDate))
    const span = [...dates, ...(targets ?? []).map((cell) => cell.stayDate)].sort()
    const existing = span.length === 0 || roomTypeIds.length === 0 ? [] : await tx.roomSalesRule.findMany({
      where: { tenantId, hotelId: hotel.id, roomTypeId: { in: roomTypeIds }, stayDate: { gte: toDate(span[0]), lte: toDate(span[span.length - 1]) }, poolKey: scopeKey(scope.poolId), planKey: scopeKey(scope.ratePlanId), channelKey: scopeKey(scope.channel), marketKey: scopeKey(scope.market), contractKey: scopeKey(scope.contractId) },
    })
    const byKey = new Map(existing.map((rule) => [`${rule.roomTypeId}|${day(rule.stayDate)}`, rule]))
    const weekdays = (body.weekdays ?? []).filter((item) => (WEEKDAYS as readonly string[]).includes(item))
    const selectedDates = dates.filter((date) => weekdays.length === 0 || weekdays.includes(weekdayOf(date)))
    const keys = targets && targets.length > 0 ? targets : roomTypeIds.flatMap((roomTypeId) => selectedDates.map((stayDate) => ({ roomTypeId, stayDate })))
    const current = keys.map((cell) => {
      const row = byKey.get(`${cell.roomTypeId}|${cell.stayDate}`)
      return { roomTypeId: cell.roomTypeId, stayDate: cell.stayDate, expectedVersion: row?.version ?? null, current: row ? { version: row.version, mode: row.mode as RoomSalesMode, planKey: row.planKey, channelKey: row.channelKey, marketKey: row.marketKey, contractKey: row.contractKey } : null }
    })
    const planned = planSalesBatch({
      roomTypeIds, from: body.from, to: body.to, weekdays, mode: body.mode, salesCap: body.salesCap ?? null, deadlineHours: body.responseDeadlineHours ?? null,
      owner: body.requestOwnerLabel ?? null, escalation: body.escalationPolicy ?? null, reason: body.reason ?? '', confirmBroadReopen: body.confirmBroadReopen === true,
      canReopenBroad: await this.canReopenBroad(tx, tenantId, userId), allotmentType: contract?.allotmentType ?? null, current, targets: targets && targets.length > 0 ? targets : undefined,
    })
    const fingerprint = salesFingerprint({ scope, mode: body.mode, salesCap: body.salesCap ?? null, deadline: body.responseDeadlineHours ?? null, owner: body.requestOwnerLabel ?? null, escalation: body.escalationPolicy ?? null, reason: (body.reason ?? '').trim(), cells: current.map((cell) => [cell.roomTypeId, cell.stayDate, cell.expectedVersion]) })
    return { hotel, scope, rooms, planned, fingerprint, contractAllotment: contract?.allotmentType ?? null }
  }

  async preview(tenantId: string, userId: string, hotelId: string, body: RoomSalesPreviewRequest): Promise<RoomSalesPreview> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const prepared = await this.prepare(tx, tenantId, userId, hotelId, body)
      const names = new Map(prepared.rooms.map((room) => [room.id, room.name]))
      return {
        fingerprint: prepared.fingerprint, hotelId: prepared.hotel.id, timeZone: prepared.hotel.timeZone, scopeLabel: this.scopeLabel(prepared.scope, null), from: body.from, to: body.to, roomTypeIds: prepared.planned.cells.map((cell) => cell.roomTypeId).filter((id, index, all) => all.indexOf(id) === index),
        affected: prepared.planned.cells.length, changes: prepared.planned.cells.slice(0, 200).map((cell) => ({ roomTypeId: cell.roomTypeId, roomName: names.get(cell.roomTypeId) ?? 'Room', stayDate: cell.stayDate, fromMode: cell.current?.mode ?? null, toMode: body.mode, problems: [] })),
        errors: [...prepared.planned.errors, ...prepared.planned.conflicts], canSave: prepared.planned.ok && prepared.planned.cells.length > 0, distributionNote: NOTE,
      }
    })
  }

  async commit(tenantId: string, userId: string, hotelId: string, body: RoomSalesCommitRequest, requestId: string | null): Promise<RoomSalesCommitResult> {
    if (typeof body?.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new BadRequestException('idempotencyKey is required')
    if (typeof body.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)) throw new BadRequestException('Preview the change first')
    const requestHash = salesFingerprint({ hotelId, scope: this.scopeOf(body), mode: body.mode, salesCap: body.salesCap ?? null, from: body.from, to: body.to, rooms: body.allRoomTypes ? 'all' : body.roomTypeIds, weekdays: body.weekdays ?? [], cells: (body.cells ?? []).map((cell) => [cell.roomTypeId, cell.stayDate]), reason: (body.reason ?? '').trim() })
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelId)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`room-sales:${tenantId}:${hotel.id}`}))`
      const prior = await tx.roomSalesBatch.findFirst({ where: { tenantId, idempotencyKey: body.idempotencyKey }, select: { id: true, requestHash: true, cellCount: true, job: { select: { id: true, status: true } } } })
      const decision = idempotencyDecision(prior?.requestHash ?? null, requestHash)
      if (decision === 'conflict') throw new ConflictException({ message: 'This idempotency key was already used for a different request.', code: 'IDEMPOTENCY_KEY_REUSED' })
      if (decision === 'replay' && prior) return { replayed: true, batchId: prior.id, affected: prior.cellCount, distribution: { jobId: prior.job?.id ?? '', state: prior.job?.status ?? 'PENDING', simulated: true as const, label: simulatedDistribution.label }, auditRequestId: requestId ?? '' }
      const prepared = await this.prepare(tx, tenantId, userId, hotel.id, body)
      if (!prepared.planned.ok) throw new UnprocessableEntityException({ message: [...prepared.planned.errors, ...prepared.planned.conflicts], code: 'SALES_BATCH_INVALID' })
      if (prepared.fingerprint !== body.expectedFingerprint) throw new ConflictException({ message: 'The calendar changed after the preview. Nothing was saved.', code: 'SALES_STALE' })
      if (prepared.planned.reopensBroad && !prepared.planned.ok) throw new ForbiddenException('Reopening a room-wide Stop Sale is not allowed')
      const batch = await tx.roomSalesBatch.create({ data: { tenantId, hotelId: hotel.id, reason: body.reason.trim(), actorId: userId, cellCount: prepared.planned.cells.length, idempotencyKey: body.idempotencyKey, requestHash } })
      const keys = { poolKey: scopeKey(prepared.scope.poolId), planKey: scopeKey(prepared.scope.ratePlanId), channelKey: scopeKey(prepared.scope.channel), marketKey: scopeKey(prepared.scope.market), contractKey: scopeKey(prepared.scope.contractId) }
      for (const cell of prepared.planned.cells) {
        const existing = await tx.roomSalesRule.findFirst({ where: { tenantId, roomTypeId: cell.roomTypeId, stayDate: toDate(cell.stayDate), ...keys } })
        if ((existing?.version ?? null) !== cell.expectedVersion) throw new ConflictException({ message: 'A cell changed while saving. Nothing was saved.', code: 'SALES_STALE' })
        const data = {
          mode: body.mode, salesCap: body.mode === 'LIMITED' ? body.salesCap ?? null : null, consumesInventory: prepared.planned.consumesInventory,
          responseDeadlineHours: body.mode === 'ON_REQUEST' ? body.responseDeadlineHours ?? null : null, requestOwnerLabel: body.mode === 'ON_REQUEST' ? body.requestOwnerLabel?.trim() ?? null : null,
          escalationPolicy: body.mode === 'ON_REQUEST' ? body.escalationPolicy?.trim() ?? null : null, reason: body.reason.trim(), source: 'MANUAL', batchId: batch.id, actorId: userId,
        }
        if (existing) {
          const updated = await tx.roomSalesRule.updateMany({ where: { id: existing.id, tenantId, version: existing.version }, data: { ...data, version: existing.version + 1 } })
          if (updated.count !== 1) throw new ConflictException({ message: 'A cell changed while saving. Nothing was saved.', code: 'SALES_STALE' })
        } else {
          await tx.roomSalesRule.create({ data: { tenantId, hotelId: hotel.id, roomTypeId: cell.roomTypeId, stayDate: toDate(cell.stayDate), ...keys, ...data, version: 1 } })
        }
        await tx.roomSalesAudit.create({ data: { tenantId, hotelId: hotel.id, batchId: batch.id, roomTypeId: cell.roomTypeId, stayDate: toDate(cell.stayDate), beforeMode: existing?.mode ?? null, afterMode: body.mode, beforeCap: existing?.salesCap ?? null, afterCap: body.mode === 'LIMITED' ? body.salesCap ?? null : null, actorId: userId, source: 'MANUAL', reason: body.reason.trim() } })
      }
      const job = await tx.salesDistributionJob.create({ data: { tenantId, hotelId: hotel.id, batchId: batch.id, status: 'PENDING', payloadHash: requestHash, simulated: true } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'inventory.sales.saved', entityType: 'hotel', entityId: hotel.id, payload: { outcome: 'allowed', requestId, batchId: batch.id, affected: prepared.planned.cells.length, mode: body.mode, distribution: 'PENDING' } as unknown as Prisma.InputJsonValue } })
      return { replayed: false, batchId: batch.id, affected: prepared.planned.cells.length, distribution: { jobId: job.id, state: 'PENDING' as const, simulated: true as const, label: simulatedDistribution.label }, auditRequestId: requestId ?? '' }
    })
  }

  async history(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<SalesHistoryEntry[]> {
    const roomTypeId = idParam('roomTypeId', query.roomTypeId)
    const stayDate = typeof query.stayDate === 'string' ? query.stayDate : ''
    if (!roomTypeId || !isIsoDate(stayDate)) throw new BadRequestException('roomTypeId and stayDate are required')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const rows = await tx.roomSalesAudit.findMany({ where: { tenantId, hotelId: hotel.id, roomTypeId, stayDate: toDate(stayDate) }, orderBy: { createdAt: 'desc' }, take: 30 })
      const actors = await this.names(tx, tenantId, [...new Set(rows.map((row) => row.actorId))])
      return rows.map((row) => ({ at: row.createdAt.toISOString(), actorName: actors.get(row.actorId) ?? 'Team member', source: row.source, reason: row.reason, beforeMode: row.beforeMode as RoomSalesMode | null, afterMode: row.afterMode as RoomSalesMode | null, beforeCap: row.beforeCap, afterCap: row.afterCap }))
    })
  }

  async allocation(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<AllocationBoard> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const today = dayInZone(this.clock(), hotel.timeZone)
      const w = this.window(query, today)
      const rooms = await tx.roomType.findMany({ where: { hotelId: hotel.id, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
      const plans = await tx.ratePlan.findMany({ where: { tenantId, roomType: { hotelId: hotel.id } }, select: { id: true, roomTypeId: true, inventoryPoolId: true } })
      const pools = await tx.inventoryPool.findMany({ where: { tenantId, hotelId: hotel.id, status: 'ACTIVE' }, select: { id: true, name: true } })
      const poolIds = pools.map((pool) => pool.id)
      const days = poolIds.length === 0 ? [] : await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: { in: poolIds }, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } } })
      const allocations = poolIds.length === 0 ? [] : await tx.poolNightAllocation.findMany({ where: { tenantId, hotelId: hotel.id, poolId: { in: poolIds }, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } } })
      const rows = rooms.flatMap((room) => {
        const roomPools = pools.filter((pool) => plans.some((plan) => plan.roomTypeId === room.id && plan.inventoryPoolId === pool.id))
        const groups = roomPools.length > 0 ? roomPools.map((pool) => ({ poolId: pool.id, poolName: pool.name })) : [{ poolId: null, poolName: 'No shared pool' }]
        return groups.map((group) => ({
          roomTypeId: room.id, roomName: room.name, poolId: group.poolId, poolName: group.poolName,
          nights: w.dates.map((date): AllocationNightView => {
            if (!group.poolId) return { roomTypeId: room.id, roomName: room.name, poolId: null, poolName: group.poolName, stayDate: date, contracted: null, approvedAdjustment: null, confirmed: null, activeHolds: null, blocked: null, blockedExcludedFromAllocation: false, remaining: null, consistent: null, overCommitment: false, releaseCutoff: null, postReleasePolicy: null, exists: false, version: null }
            const stock = days.find((row) => row.poolId === group.poolId && day(row.stayDate) === date)
            const allocation = allocations.find((row) => row.poolId === group.poolId && day(row.stayDate) === date)
            if (!stock) return { roomTypeId: room.id, roomName: room.name, poolId: group.poolId, poolName: group.poolName, stayDate: date, contracted: null, approvedAdjustment: null, confirmed: null, activeHolds: null, blocked: null, blockedExcludedFromAllocation: false, remaining: null, consistent: null, overCommitment: false, releaseCutoff: null, postReleasePolicy: null, exists: false, version: allocation?.version ?? null }
            const contracted = allocation?.contracted ?? stock.capacity
            const adjustment = allocation?.approvedAdjustment ?? 0
            const blocked = allocation?.blockedQuantity ?? 0
            const excluded = allocation?.blockedExcludedFromAllocation ?? false
            const remaining = availableInventory({ contracted, approvedAdjustment: adjustment, confirmed: stock.sold, activeHolds: stock.held, blocked, blockedAlreadyExcluded: excluded })
            const intended = contracted + adjustment - (excluded ? 0 : blocked)
            return {
              roomTypeId: room.id, roomName: room.name, poolId: group.poolId, poolName: group.poolName, stayDate: date, contracted, approvedAdjustment: adjustment, confirmed: stock.sold, activeHolds: stock.held, blocked, blockedExcludedFromAllocation: excluded, remaining,
              consistent: stock.capacity === Math.max(intended, stock.sold + stock.held), overCommitment: remaining < 0, releaseCutoff: allocation?.releaseCutoffDays == null ? null : `${allocation.releaseCutoffDays} days before arrival at ${allocation.releaseTimeLocal ?? '00:00'}`,
              postReleasePolicy: (allocation?.postReleasePolicy ?? 'CLOSED') as AllocationNightView['postReleasePolicy'], exists: true, version: allocation?.version ?? null,
            }
          }),
        }))
      })
      const fingerprints = pools.map((pool) => {
        const present = w.dates.every((date) => days.some((row) => row.poolId === pool.id && day(row.stayDate) === date))
        return { poolId: pool.id, fingerprint: present ? salesFingerprint(w.dates.map((date) => { const row = days.find((item) => item.poolId === pool.id && day(item.stayDate) === date)!; return [date, row.capacity, row.sold, row.held, row.updatedAt.toISOString()] })) : null }
      })
      return { hotelId: hotel.id, hotelName: hotel.name, timeZone: hotel.timeZone, hotelToday: today, generatedAt: this.clock().toISOString(), window: { from: w.from, to: w.to, days: w.days }, dates: w.dates, rows, fingerprints, notes: ['Remaining inventory is contracted allocation plus approved adjustments, minus confirmed bookings, active holds and blocked rooms that are not already excluded.', 'Confirmed bookings are kept when a figure is reduced below them. Further sales stop.', 'Rate plans in one pool share one count.'] }
    })
  }

  async applyAllocation(tenantId: string, userId: string, hotelIdRaw: string, body: AllocationEditRequest, requestId: string | null): Promise<AllocationEditResult> {
    if (typeof body?.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new BadRequestException('idempotencyKey is required')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3) throw new BadRequestException('A reason is required')
    if ([body.contracted, body.approvedAdjustment, body.blocked].some((value) => !Number.isInteger(value) || value < 0 || value > 9999)) throw new BadRequestException('Allocation figures must be whole numbers from 0 to 9999')
    const dates = inclusiveDates(body.from, body.to)
    if (!dates) throw new BadRequestException('Invalid stay dates')
    const selected = dates.filter((date) => !body.weekdays?.length || body.weekdays.includes(weekdayOf(date)))
    const requestHash = salesFingerprint({ kind: 'allocation', poolId: body.poolId, selected, contracted: body.contracted, adjustment: body.approvedAdjustment, blocked: body.blocked, excluded: body.blockedExcludedFromAllocation, policy: body.postReleasePolicy, reason })
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`room-sales:${tenantId}:${hotel.id}`}))`
      const prior = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: hotel.id, action: 'inventory.allocation.updated', payload: { path: ['idempotencyKey'], equals: body.idempotencyKey } }, select: { payload: true } })
      const stored = prior ? (prior.payload as { requestHash?: string; updated?: number; over?: string[]; requestId?: string }).requestHash ?? null : null
      const decision = idempotencyDecision(prior ? stored : null, requestHash)
      if (decision === 'conflict') throw new ConflictException({ message: 'This idempotency key was already used for a different request.', code: 'IDEMPOTENCY_KEY_REUSED' })
      if (decision === 'replay') {
        const payload = prior!.payload as { updated?: number; over?: string[]; requestId?: string }
        return { replayed: true, updated: payload.updated ?? 0, overCommitmentNights: payload.over ?? [], auditRequestId: payload.requestId ?? '' }
      }
      const pool = await tx.inventoryPool.findFirst({ where: { id: body.poolId, tenantId, hotelId: hotel.id, status: 'ACTIVE' }, select: { id: true } })
      if (!pool) throw new NotFoundException('Pool not found')
      const days = await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: pool.id, stayDate: { in: selected.map(toDate) } } })
      const byDate = new Map(days.map((row) => [day(row.stayDate), row]))
      const missing = selected.filter((date) => !byDate.has(date))
      if (missing.length) throw new UnprocessableEntityException({ message: [`These nights have no pool stock row, so they were not changed: ${missing.slice(0, 8).join(', ')}`], code: 'ALLOCATION_UNKNOWN' })
      const fingerprint = salesFingerprint(selected.map((date) => { const row = byDate.get(date)!; return [date, row.capacity, row.sold, row.held, row.updatedAt.toISOString()] }))
      if (fingerprint !== body.expectedFingerprint) throw new ConflictException({ message: 'Pool stock changed after the screen was loaded. Nothing was saved.', code: 'ALLOCATION_STALE' })
      const over: string[] = []
      for (const date of selected) {
        const row = byDate.get(date)!
        const remaining = availableInventory({ contracted: body.contracted, approvedAdjustment: body.approvedAdjustment, confirmed: row.sold, activeHolds: row.held, blocked: body.blocked, blockedAlreadyExcluded: body.blockedExcludedFromAllocation })
        if (remaining < 0) over.push(date)
        const intended = body.contracted + body.approvedAdjustment - (body.blockedExcludedFromAllocation ? 0 : body.blocked)
        const capacity = Math.max(intended, row.sold + row.held)
        const changed = await tx.$executeRaw(Prisma.sql`
          UPDATE "InventoryPoolDay" SET "capacity" = ${capacity}, "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${row.id} AND "tenant_id" = ${tenantId} AND "pool_id" = ${pool.id} AND "sold" + "held" <= ${capacity}
             AND "sold" = ${row.sold} AND "held" = ${row.held} AND "updated_at" = ${row.updatedAt}
        `)
        if (changed !== 1) throw new ConflictException({ message: 'Pool stock changed while saving. Nothing was saved.', code: 'ALLOCATION_STALE' })
        const existing = await tx.poolNightAllocation.findFirst({ where: { tenantId, poolId: pool.id, stayDate: toDate(date) } })
        const data = { contracted: body.contracted, approvedAdjustment: body.approvedAdjustment, blockedQuantity: body.blocked, blockedExcludedFromAllocation: body.blockedExcludedFromAllocation, postReleasePolicy: body.postReleasePolicy, releaseCutoffDays: body.releaseCutoffDays, releaseTimeLocal: body.releaseTimeLocal, responseDeadlineHours: body.responseDeadlineHours ?? null, requestOwnerLabel: body.requestOwnerLabel ?? null, escalationPolicy: body.escalationPolicy ?? null }
        if (existing) await tx.poolNightAllocation.updateMany({ where: { id: existing.id, tenantId, version: existing.version }, data: { ...data, version: existing.version + 1 } })
        else await tx.poolNightAllocation.create({ data: { tenantId, hotelId: hotel.id, poolId: pool.id, stayDate: toDate(date), ...data, version: 1 } })
      }
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'inventory.allocation.updated', entityType: 'hotel', entityId: hotel.id, payload: { outcome: 'allowed', requestId, idempotencyKey: body.idempotencyKey, requestHash, updated: selected.length, over, reason, poolId: pool.id } as unknown as Prisma.InputJsonValue } })
      return { replayed: false, updated: selected.length, overCommitmentNights: over, auditRequestId: requestId ?? '' }
    })
  }

  async releaseAllocation(tenantId: string, userId: string, hotelIdRaw: string, body: { poolId: string; from: string; to: string; weekdays?: string[]; reason: string; idempotencyKey: string; expectedFingerprint: string }, requestId: string | null): Promise<AllocationEditResult> {
    if (!KEY.test(body?.idempotencyKey ?? '')) throw new BadRequestException('idempotencyKey is required')
    const dates = inclusiveDates(body.from, body.to)
    if (!dates) throw new BadRequestException('Invalid stay dates')
    const selected = dates.filter((date) => !(body.weekdays ?? []).length || (body.weekdays ?? []).includes(weekdayOf(date)))
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`room-sales:${tenantId}:${hotel.id}`}))`
      const pool = await tx.inventoryPool.findFirst({ where: { id: body.poolId, tenantId, hotelId: hotel.id }, select: { id: true } })
      if (!pool) throw new NotFoundException('Pool not found')
      const days = await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: pool.id, stayDate: { in: selected.map(toDate) } } })
      const allocations = await tx.poolNightAllocation.findMany({ where: { tenantId, poolId: pool.id, stayDate: { in: selected.map(toDate) } } })
      const members = await tx.ratePlan.findMany({ where: { tenantId, inventoryPoolId: pool.id }, select: { roomTypeId: true, contract: { select: { allotmentType: true } } } })
      const batch = await tx.roomSalesBatch.create({ data: { tenantId, hotelId: hotel.id, reason: body.reason.trim(), actorId: userId, cellCount: selected.length, idempotencyKey: body.idempotencyKey, requestHash: salesFingerprint({ kind: 'release', poolId: pool.id, selected }) } })
      const over: string[] = []
      for (const row of days) {
        const allocation = allocations.find((item) => day(item.stayDate) === day(row.stayDate))
        const terms = { contracted: allocation?.contracted ?? row.capacity, approvedAdjustment: allocation?.approvedAdjustment ?? 0, confirmed: row.sold, activeHolds: row.held, blocked: allocation?.blockedQuantity ?? 0, blockedAlreadyExcluded: allocation?.blockedExcludedFromAllocation ?? false }
        const released = releasedContracted(terms)
        if (availableInventory(terms) < 0) over.push(day(row.stayDate))
        const capacity = row.sold + row.held
        const changed = await tx.$executeRaw(Prisma.sql`
          UPDATE "InventoryPoolDay" SET "capacity" = ${capacity}, "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${row.id} AND "tenant_id" = ${tenantId} AND "sold" + "held" = ${capacity} AND "updated_at" = ${row.updatedAt}
        `)
        if (changed !== 1) throw new ConflictException({ message: 'Pool stock changed while releasing. Nothing was saved.', code: 'ALLOCATION_STALE' })
        if (allocation) await tx.poolNightAllocation.updateMany({ where: { id: allocation.id, tenantId }, data: { contracted: released.contracted, version: allocation.version + 1 } })
        const policy = (allocation?.postReleasePolicy ?? 'CLOSED') as 'CLOSED' | 'ON_REQUEST' | 'AUTHORIZED_FREE_SALE'
        const mode = postReleaseMode(policy)
        const authorized = members.some((member) => member.contract.allotmentType === 'FREE_SALE')
        if (mode === 'FREE_SALE' && !authorized) throw new UnprocessableEntityException({ message: ['Post-release free sale is not authorized on this pool.'], code: 'RELEASE_NOT_AUTHORIZED' })
        for (const roomTypeId of [...new Set(members.map((member) => member.roomTypeId))]) {
          const existing = await tx.roomSalesRule.findFirst({ where: { tenantId, roomTypeId, stayDate: row.stayDate, poolKey: pool.id, planKey: '', channelKey: '', marketKey: '', contractKey: '' } })
          const data = { mode, salesCap: null, consumesInventory: mode !== 'FREE_SALE', responseDeadlineHours: mode === 'ON_REQUEST' ? allocation?.responseDeadlineHours ?? null : null, requestOwnerLabel: mode === 'ON_REQUEST' ? allocation?.requestOwnerLabel ?? null : null, escalationPolicy: mode === 'ON_REQUEST' ? allocation?.escalationPolicy ?? null : null, reason: body.reason.trim(), source: 'RELEASE', batchId: batch.id, actorId: userId }
          if (existing) await tx.roomSalesRule.updateMany({ where: { id: existing.id, tenantId }, data: { ...data, version: existing.version + 1 } })
          else await tx.roomSalesRule.create({ data: { tenantId, hotelId: hotel.id, roomTypeId, stayDate: row.stayDate, poolKey: pool.id, planKey: '', channelKey: '', marketKey: '', contractKey: '', ...data, version: 1 } })
          await tx.roomSalesAudit.create({ data: { tenantId, hotelId: hotel.id, batchId: batch.id, roomTypeId, stayDate: row.stayDate, beforeMode: existing?.mode ?? null, afterMode: mode, beforeCap: existing?.salesCap ?? null, afterCap: null, actorId: userId, source: 'RELEASE', reason: body.reason.trim() } })
        }
      }
      await tx.salesDistributionJob.create({ data: { tenantId, hotelId: hotel.id, batchId: batch.id, status: 'PENDING', payloadHash: batch.requestHash, simulated: true } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'inventory.allocation.released', entityType: 'hotel', entityId: hotel.id, payload: { outcome: 'allowed', requestId, poolId: pool.id, nights: days.length } as unknown as Prisma.InputJsonValue } })
      return { replayed: false, updated: days.length, overCommitmentNights: over, auditRequestId: requestId ?? '' }
    })
  }

  async eligibility(tenantId: string, hotelIdRaw: string, body: SalesEligibilityRequest): Promise<SalesEligibilityResult> {
    return this.prisma.withTenant(tenantId, (tx) => this.checkStay(tx, tenantId, hotelIdRaw, body))
  }

  private async checkStay(tx: Tx, tenantId: string, hotelIdRaw: string, body: SalesEligibilityRequest): Promise<SalesEligibilityResult> {
    const nights = isIsoDate(body.checkIn) && isIsoDate(body.checkOut) ? stayNights(body.checkIn, body.checkOut) : null
    if (!nights) throw new BadRequestException('Invalid stay')
    if (!Number.isInteger(body.rooms) || body.rooms < 1) throw new BadRequestException('Invalid room quantity')
    {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const plan = await tx.ratePlan.findFirst({ where: { id: body.ratePlanId, tenantId, roomType: { hotelId: hotel.id } }, select: { id: true, roomTypeId: true, inventoryPoolId: true, contractId: true, status: true } })
      if (!plan || plan.status !== 'ACTIVE') throw new NotFoundException('Rate plan not found')
      const rules = await tx.roomSalesRule.findMany({ where: { tenantId, hotelId: hotel.id, roomTypeId: plan.roomTypeId, stayDate: { in: nights.map(toDate) } } })
      const views = rules.map((rule) => ({ roomTypeId: rule.roomTypeId, stayDate: day(rule.stayDate), poolKey: rule.poolKey, planKey: rule.planKey, channelKey: rule.channelKey, marketKey: rule.marketKey, contractKey: rule.contractKey, mode: rule.mode as RoomSalesMode, salesCap: rule.salesCap, consumesInventory: rule.consumesInventory, overrideExpiresAt: rule.overrideExpiresAt ? rule.overrideExpiresAt.toISOString() : null }))
      const rates = await tx.dailyRate.findMany({ where: { tenantId, ratePlanId: plan.id, stayDate: { in: nights.map(toDate) } }, select: { stayDate: true, amountMinor: true } })
      const poolDays = plan.inventoryPoolId ? await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: plan.inventoryPoolId, stayDate: { in: nights.map(toDate) } } }) : []
      const allocation = plan.inventoryPoolId ? await tx.poolNightAllocation.findMany({ where: { tenantId, poolId: plan.inventoryPoolId, stayDate: { in: nights.map(toDate) } } }) : []
      const reasons: string[] = []
      let onRequest = false
      for (const date of nights) {
        const stock = poolDays.find((row) => day(row.stayDate) === date)
        const split = allocation.find((row) => day(row.stayDate) === date)
        const consumed = stock ? stock.sold + stock.held : null
        const resolved = resolveRoomSales({ rules: views, roomTypeId: plan.roomTypeId, ratePlanId: plan.id, poolId: plan.inventoryPoolId, contractId: plan.contractId, stayDate: date, channel: body.channel ?? null, market: body.market ?? null, now: this.clock(), consumed })
        const rate = rates.find((row) => day(row.stayDate) === date)
        const remaining = stock ? availableInventory({ contracted: split?.contracted ?? stock.capacity, approvedAdjustment: split?.approvedAdjustment ?? 0, confirmed: stock.sold, activeHolds: stock.held, blocked: split?.blockedQuantity ?? 0, blockedAlreadyExcluded: split?.blockedExcludedFromAllocation ?? false }) : null
        const effect = effectiveOutcome({ resolved, verifiedRate: !!rate && rate.amountMinor > 0n, quarantinedRate: !!rate && rate.amountMinor <= 0n, inventoryRemaining: remaining, legacyMode: null, legacyStop: false, roomsRequested: body.rooms })
        if (effect.outcome === 'ON_REQUEST') onRequest = true
        if (effect.outcome !== 'INSTANT') reasons.push(`${date}: ${effect.reasons[0] ?? effect.outcome}`)
      }
      if (reasons.length > 0 && !onRequest) return { outcome: 'REJECTED', reasons, nights, note: 'Instant confirmation was not created. No inventory was consumed.' }
      if (reasons.some((reason) => !reason.includes('Supplier confirmation')) ) return { outcome: 'REJECTED', reasons, nights, note: 'The stay was not split. No night was confirmed on its own.' }
      if (onRequest || reasons.length > 0) return { outcome: 'ON_REQUEST', reasons, nights, note: 'A supplier request is required for the whole stay. This check did not confirm a booking.' }
      return { outcome: 'INSTANT', reasons: [], nights, note: 'Eligible for instant confirmation only if the booking hold rechecks these controls and still finds inventory. This response does not reserve a room.' }
    }
  }

  async createRequest(tenantId: string, userId: string, hotelId: string, body: SupplierStayRequestBody): Promise<SupplierStayRequestView> {
    if (!KEY.test(body.idempotencyKey ?? '')) throw new BadRequestException('idempotencyKey is required')
    const decision = await this.eligibility(tenantId, hotelId, body)
    if (decision.outcome !== 'ON_REQUEST') throw new UnprocessableEntityException({ message: decision.outcome === 'REJECTED' ? decision.reasons : ['This stay can be confirmed instantly, so a supplier request was not opened.'], code: 'REQUEST_NOT_ALLOWED' })
    const requestHash = salesFingerprint({ ratePlanId: body.ratePlanId, checkIn: body.checkIn, checkOut: body.checkOut, rooms: body.rooms, deadline: body.responseDeadlineHours, owner: body.requestOwnerLabel, escalation: body.escalationPolicy })
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelId)
      const prior = await tx.supplierStayRequest.findFirst({ where: { tenantId, idempotencyKey: body.idempotencyKey } })
      if (prior && prior.requestHash !== requestHash) throw new ConflictException({ message: 'This idempotency key was already used for a different request.', code: 'IDEMPOTENCY_KEY_REUSED' })
      if (prior) return { id: prior.id, status: prior.status, deadlineAt: prior.deadlineAt.toISOString(), ownerLabel: prior.ownerLabel, escalationPolicy: prior.escalationPolicy, replayed: true, note: 'The existing request was returned. No second request was created.' }
      const plan = await tx.ratePlan.findFirst({ where: { id: body.ratePlanId, tenantId, roomType: { hotelId: hotel.id } }, select: { roomTypeId: true } })
      if (!plan) throw new NotFoundException('Rate plan not found')
      const created = await tx.supplierStayRequest.create({ data: { tenantId, hotelId: hotel.id, roomTypeId: plan.roomTypeId, ratePlanId: body.ratePlanId, checkIn: toDate(body.checkIn), checkOut: toDate(body.checkOut), rooms: body.rooms, status: 'PENDING', deadlineAt: new Date(this.clock().getTime() + body.responseDeadlineHours * 3_600_000), ownerLabel: body.requestOwnerLabel.trim(), escalationPolicy: body.escalationPolicy.trim(), idempotencyKey: body.idempotencyKey, requestHash, createdById: userId } })
      return { id: created.id, status: 'PENDING', deadlineAt: created.deadlineAt.toISOString(), ownerLabel: created.ownerLabel, escalationPolicy: created.escalationPolicy, replayed: false, note: 'Pending supplier confirmation. This is not a confirmed reservation, and no temporary hold was taken.' }
    })
  }

  async decideRequest(tenantId: string, hotelId: string, requestIdRaw: string, body: SupplierStayDecision): Promise<SupplierStayRequestView> {
    const requestId = idParam('requestId', requestIdRaw)
    if (!requestId) throw new BadRequestException('Invalid requestId')
    if (!body.reason || body.reason.trim().length < 3) throw new BadRequestException('A reason is required')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelId)
      const request = await tx.supplierStayRequest.findFirst({ where: { id: requestId, tenantId, hotelId: hotel.id } })
      if (!request) throw new NotFoundException('Request not found')
      if (request.status !== 'PENDING') return { id: request.id, status: request.status, deadlineAt: request.deadlineAt.toISOString(), ownerLabel: request.ownerLabel, escalationPolicy: request.escalationPolicy, replayed: true, note: 'The request was already decided.' }
      if (body.decision === 'APPROVE') {
        const check = await this.checkStay(tx, tenantId, hotel.id, { ratePlanId: request.ratePlanId, checkIn: day(request.checkIn), checkOut: day(request.checkOut), rooms: request.rooms, adults: 2, children: 0 })
        if (check.outcome === 'REJECTED') throw new UnprocessableEntityException({ message: ['Approval rechecked the stay and it is no longer allowed.', ...check.reasons], code: 'REQUEST_RECHECK_FAILED' })
      }
      const status = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'
      await tx.supplierStayRequest.updateMany({ where: { id: request.id, tenantId, status: 'PENDING' }, data: { status, decisionReason: body.reason.trim() } })
      return { id: request.id, status, deadlineAt: request.deadlineAt.toISOString(), ownerLabel: request.ownerLabel, escalationPolicy: request.escalationPolicy, replayed: false, note: status === 'APPROVED' ? 'Approved after a fresh check. A reservation is still created only by the booking commitment.' : 'Rejected. No inventory was held for this request.' }
    })
  }

  async expireRequests(tenantId: string, hotelId: string): Promise<{ expired: number }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelId)
      const result = await tx.supplierStayRequest.updateMany({ where: { tenantId, hotelId: hotel.id, status: 'PENDING', deadlineAt: { lte: this.clock() } }, data: { status: 'EXPIRED', decisionReason: 'Response deadline passed' } })
      return { expired: result.count }
    })
  }

  async listDistribution(tenantId: string, hotelId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelId)
      const jobs = await tx.salesDistributionJob.findMany({ where: { tenantId, hotelId: hotel.id }, orderBy: { createdAt: 'desc' }, take: 20 })
      return jobs.map((job) => ({ id: job.id, state: job.status, attempts: job.attempts, lastError: job.lastError, simulated: true as const, label: simulatedDistribution.label, createdAt: job.createdAt.toISOString() }))
    })
  }

  async deliverDistribution(tenantId: string, hotelId: string, jobIdRaw: string, forceFailure: boolean) {
    const jobId = idParam('jobId', jobIdRaw)
    if (!jobId) throw new BadRequestException('Invalid jobId')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelId)
      const job = await tx.salesDistributionJob.findFirst({ where: { id: jobId, tenantId, hotelId: hotel.id } })
      if (!job) throw new NotFoundException('Distribution job not found')
      if (job.status === 'ACKNOWLEDGED') return { id: job.id, state: job.status, attempts: job.attempts, simulated: true as const, label: simulatedDistribution.label, note: 'Already acknowledged by the simulated adapter. It was not sent again.' }
      const result = await this.distribution.deliver({ jobId: job.id, payloadHash: job.payloadHash, forceFailure })
      const { applyDelivery } = await import('./engine')
      const next = applyDelivery({ state: job.status, attempts: job.attempts, lastError: job.lastError }, result)
      await tx.salesDistributionJob.updateMany({ where: { id: job.id, tenantId, status: job.status }, data: { status: next.state, attempts: next.attempts, lastError: next.lastError, acknowledgedAt: next.state === 'ACKNOWLEDGED' ? this.clock() : null } })
      return { id: job.id, state: next.state, attempts: next.attempts, simulated: true as const, label: simulatedDistribution.label, note: next.state === 'ACKNOWLEDGED' ? 'Acknowledged by the simulated channel adapter. This is not a live supplier acknowledgement.' : `Simulated delivery failed: ${next.lastError ?? 'unknown'}. The internal save is unchanged.` }
    })
  }
}
