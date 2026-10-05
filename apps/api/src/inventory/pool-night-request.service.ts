import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { PoolNightDecision, PoolNightRequestBody, PoolNightRequestList, PoolNightRequestView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { idParam } from '../admin-operations/query-params'
import { dayInZone, expandDates } from '../hotel-setup/quick-update-rules'
import { planNights, validateNightRequest } from './pool-night-authoring'

export const POOL_NIGHT_REQUEST_ACTION = 'supply.pool_nights.request'
export const POOL_NIGHT_ENTITY = 'inventory_pool'
const isoDay = (d: Date) => d.toISOString().slice(0, 10)

interface Proposed { hotelId?: string; startDate?: string; endDate?: string; capacity?: number; missingNights?: number }

/**
 * Maker-checker requests to open new pool nights (ADR 0036 Amendment 4). Creating a pool stock row needs INSERT, which the strict API role never holds,
 * so this service only records, lists, decides and cancels requests (ApprovalRequest writes the role already has). It never writes a night: the database
 * owner applies an APPROVED request with `ops:pool-nights --approval`, which re-validates everything against the live pool.
 */
@Injectable()
export class PoolNightRequestService {
  /** Replaceable in tests. */
  clock: () => Date = () => new Date()
  constructor(private readonly prisma: PrismaService, private readonly approvals: ApprovalService) {}

  private async scope(tenantId: string, hotelIdRaw: string, poolIdRaw: string) {
    const hotelId = idParam('hotelId', hotelIdRaw); const poolId = idParam('poolId', poolIdRaw)
    if (!hotelId) throw new BadRequestException('Invalid hotelId')
    if (!poolId) throw new BadRequestException('Invalid poolId')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await tx.hotel.findFirst({ where: { id: hotelId, tenantId }, select: { id: true, timeZone: true } })
      if (!hotel) throw new NotFoundException('Hotel not found')
      const pool = await tx.inventoryPool.findFirst({ where: { id: poolId, tenantId, hotelId }, select: { id: true, name: true, status: true } })
      if (!pool) throw new NotFoundException('Pool not found')
      return { hotel, pool }
    })
  }

  private view(a: ApprovalView, me: string): PoolNightRequestView {
    const p = (a.proposedState ?? {}) as Proposed
    return {
      id: a.id, status: a.status, startDate: p.startDate ?? '', endDate: p.endDate ?? '', capacity: p.capacity ?? 0, missingNights: p.missingNights ?? 0,
      reason: a.reason, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason,
      executedAt: a.executedAt ? a.executedAt.toISOString() : null, createdAt: a.createdAt.toISOString(),
      canDecide: a.status === 'PENDING' && a.requestedById !== me, canCancel: a.status === 'PENDING' && a.requestedById === me,
    }
  }

  async list(tenantId: string, me: string, hotelId: string, poolId: string): Promise<PoolNightRequestList> {
    const { pool } = await this.scope(tenantId, hotelId, poolId)
    const rows = (await this.approvals.listForEntities(tenantId, POOL_NIGHT_ENTITY, [pool.id])).filter((a) => a.action === POOL_NIGHT_REQUEST_ACTION)
    return { poolId: pool.id, items: rows.slice(0, 50).map((a) => this.view(a, me)) }
  }

  async request(tenantId: string, me: string, hotelId: string, poolId: string, body: PoolNightRequestBody): Promise<PoolNightRequestList> {
    const { hotel, pool } = await this.scope(tenantId, hotelId, poolId)
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : ''
    if (requestId.length < 8 || requestId.length > 80) throw new BadRequestException('requestId is required (8 to 80 characters)')
    const errors = validateNightRequest({ tenantId, poolId: pool.id, from: body?.startDate, to: body?.endDate, capacity: body?.capacity, reason: typeof body?.reason === 'string' ? body.reason : '', actor: 'requester' })
    if (errors.length) throw new BadRequestException(errors.map((e) => e.replace('--from', 'startDate').replace('--to', 'endDate').replace('--capacity', 'capacity').replace('--reason', 'reason')))
    if (pool.status !== 'ACTIVE') throw new ConflictException({ message: 'This pool is archived; nights cannot be requested for it.', code: 'POOL_ARCHIVED' })
    const existing = await this.prisma.withTenant(tenantId, (tx) => tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: pool.id, stayDate: { gte: new Date(body.startDate), lte: new Date(body.endDate) } }, select: { stayDate: true } }))
    const plan = planNights(expandDates([{ from: body.startDate, to: body.endDate }], []), new Set(existing.map((e) => isoDay(e.stayDate))), dayInZone(this.clock(), hotel.timeZone), pool.id, body.capacity)
    if (plan.create.length === 0) throw new ConflictException({ message: 'Every night in this range already has a stock row or is before the hotel-local today, so there is nothing to open.', code: 'POOL_NIGHTS_NOTHING_TO_OPEN' })
    await this.approvals.request({
      tenantId, requesterId: me, action: POOL_NIGHT_REQUEST_ACTION, entityType: POOL_NIGHT_ENTITY, entityId: pool.id, requestId, reason: body.reason,
      beforeState: { missingNights: plan.create.length }, proposedState: { hotelId: hotel.id, startDate: body.startDate, endDate: body.endDate, capacity: body.capacity, missingNights: plan.create.length },
    })
    return this.list(tenantId, me, hotel.id, pool.id)
  }

  private async own(tenantId: string, poolId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId).catch(() => { throw new NotFoundException('Request not found') })
    if (a.action !== POOL_NIGHT_REQUEST_ACTION || a.entityType !== POOL_NIGHT_ENTITY || a.entityId !== poolId) throw new NotFoundException('Request not found')
    return a
  }

  async decide(tenantId: string, me: string, hotelId: string, poolId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: PoolNightDecision): Promise<PoolNightRequestList> {
    const { pool } = await this.scope(tenantId, hotelId, poolId)
    await this.own(tenantId, pool.id, approvalId)
    await this.approvals.decide({ tenantId, approverId: me, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.list(tenantId, me, hotelId, pool.id)
  }

  async cancel(tenantId: string, me: string, hotelId: string, poolId: string, approvalId: string): Promise<PoolNightRequestList> {
    const { pool } = await this.scope(tenantId, hotelId, poolId)
    await this.own(tenantId, pool.id, approvalId)
    await this.approvals.cancel({ tenantId, requesterId: me, approvalId })
    return this.list(tenantId, me, hotelId, pool.id)
  }
}
