import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { FORBIDDEN_PERMISSION_KEYS, permissionCatalogue } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { sanitizeAuditPayload } from '../agent/audit-payload'

export type ApprovalDecision = 'APPROVED' | 'REJECTED'
export type ApprovalStatus = 'PENDING' | ApprovalDecision | 'CANCELLED' | 'EXECUTED' | 'EXPIRED'

export interface ApprovalView {
  id: string
  tenantId: string
  action: string
  entityType: string
  entityId: string
  requestId: string
  status: ApprovalStatus
  requestedById: string
  reason: string
  beforeState: unknown
  proposedState: unknown
  decidedById: string | null
  decidedAt: Date | null
  decisionReason: string | null
  executedById: string | null
  executedAt: Date | null
  createdAt: Date
}

export interface RequestApprovalInput {
  tenantId: string
  requesterId: string
  action: string
  entityType: string
  entityId: string
  /** Caller-supplied idempotency key: repeating it returns the same request instead of creating another. */
  requestId: string
  reason: string
  beforeState?: Record<string, unknown>
  proposedState?: Record<string, unknown>
}

const MAX_REASON = 500
const MAX_STATE_BYTES = 4_000
const DEFAULT_TTL_HOURS = 72
const MAX_TTL_HOURS = 24 * 30
const MAX_EXPIRY_BATCH = 100

/**
 * How long a request may wait for a decision, and how long an approved request stays executable (ADR 0095).
 * Configuration, not code: `APPROVAL_TTL_HOURS`, a whole number of hours from 1 to 720. An unset or invalid value uses the default,
 * which is the shorter, safer reading of "not configured".
 */
export function approvalTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPROVAL_TTL_HOURS?.trim()
  const hours = raw ? Number(raw) : DEFAULT_TTL_HOURS
  return (Number.isInteger(hours) && hours >= 1 && hours <= MAX_TTL_HOURS ? hours : DEFAULT_TTL_HOURS) * 3_600_000
}

/** Money is integer minor units. A fractional number in a stored state is a defect, not a rounding question. */
function assertNoFractions(value: unknown, path = 'state'): void {
  if (typeof value === 'number' && !Number.isInteger(value)) throw new BadRequestException(`${path} must not contain fractional numbers; money is integer minor units`)
  if (Array.isArray(value)) value.forEach((v, i) => assertNoFractions(v, `${path}[${i}]`))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoFractions(v, `${path}.${k}`)
}

function cleanState(state: Record<string, unknown> | undefined, name: string): Prisma.InputJsonValue | undefined {
  if (!state) return undefined
  assertNoFractions(state, name)
  const clean = sanitizeAuditPayload(state)
  if (JSON.stringify(clean).length > MAX_STATE_BYTES) throw new BadRequestException(`${name} is too large; store identifiers and minimal values only`)
  return clean as Prisma.InputJsonValue
}

/**
 * Maker-checker foundation (ADR 0016).
 *
 * This service guarantees separation of duties, a one-way state machine, idempotent requests and audit.
 * It does NOT check that the caller holds a permission and it does NOT execute the approved action:
 * the owning controller must enforce the permission before calling it, and the owning canonical service
 * must re-validate the domain rules when it acts on an APPROVED request. Nothing consumes this yet.
 */
@Injectable()
export class ApprovalService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  async request(input: RequestApprovalInput): Promise<ApprovalView> {
    const def = permissionCatalogue.find((p) => p.key === input.action)
    if (!def || (FORBIDDEN_PERMISSION_KEYS as readonly string[]).includes(input.action)) throw new BadRequestException('Unknown approval action')
    if (def.actionClass !== 'S2' && def.actionClass !== 'S3') throw new BadRequestException('Only sensitive actions (S2, S3) use approval')
    const reason = input.reason?.trim()
    if (!reason || reason.length > MAX_REASON) throw new BadRequestException(`A reason of 1 to ${MAX_REASON} characters is required`)
    if (!input.requestId?.trim() || !input.entityType?.trim() || !input.entityId?.trim()) throw new BadRequestException('requestId, entityType and entityId are required')
    const beforeState = cleanState(input.beforeState, 'beforeState')
    const proposedState = cleanState(input.proposedState, 'proposedState')

    try {
      const row = await this.prisma.withTenant(input.tenantId, (tx) => tx.approvalRequest.create({
        data: {
          tenantId: input.tenantId, action: input.action, entityType: input.entityType, entityId: input.entityId, requestId: input.requestId,
          requestedById: input.requesterId, reason, ...(beforeState ? { beforeState } : {}), ...(proposedState ? { proposedState } : {}),
        },
      }))
      await this.audit.record({ tenantId: input.tenantId, userId: input.requesterId, action: 'approval.requested', entityType: 'approval_request', entityId: row.id, payload: { requestId: input.requestId, approvalAction: input.action, entityType: input.entityType, entityId: input.entityId } })
      return this.view(row)
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      const existing = await this.prisma.withTenant(input.tenantId, (tx) => tx.approvalRequest.findFirst({ where: { tenantId: input.tenantId, action: input.action, requestId: input.requestId } }))
      if (!existing || existing.entityType !== input.entityType || existing.entityId !== input.entityId || existing.requestedById !== input.requesterId) {
        throw new ConflictException('Approval request idempotency key conflicts')
      }
      return this.view(existing)
    }
  }

  async decide(input: { tenantId: string; approverId: string; approvalId: string; decision: ApprovalDecision; reason: string }): Promise<ApprovalView> {
    const reason = input.reason?.trim()
    if (!reason || reason.length > MAX_REASON) throw new BadRequestException(`A reason of 1 to ${MAX_REASON} characters is required`)
    await this.expireLapsed(input.tenantId)
    const current = await this.require(input.tenantId, input.approvalId)
    if (current.requestedById === input.approverId) {
      await this.audit.record({ tenantId: input.tenantId, userId: input.approverId, action: 'approval.denied', entityType: 'approval_request', entityId: current.id, payload: { approvalAction: current.action, reason: 'SELF_APPROVAL' } })
      throw new ForbiddenException('A request cannot be decided by the user who made it')
    }
    if (current.status !== 'PENDING') {
      if (current.status === input.decision && current.decidedById === input.approverId) return this.view(current)
      this.refuseIfExpired(current.status)
      throw new ConflictException(`Approval request is already ${current.status.toLowerCase()}`)
    }
    const decidedAt = new Date()
    const updated = await this.prisma.withTenant(input.tenantId, (tx) => tx.approvalRequest.updateMany({
      where: { id: input.approvalId, tenantId: input.tenantId, status: 'PENDING' },
      data: { status: input.decision, decidedById: input.approverId, decidedAt, decisionReason: reason },
    }))
    const after = await this.require(input.tenantId, input.approvalId)
    if (updated.count !== 1) {
      if (after.status === input.decision && after.decidedById === input.approverId) return this.view(after)
      this.refuseIfExpired(after.status)
      throw new ConflictException(`Approval request is already ${after.status.toLowerCase()}`)
    }
    await this.audit.record({ tenantId: input.tenantId, userId: input.approverId, action: `approval.${input.decision.toLowerCase()}`, entityType: 'approval_request', entityId: after.id, payload: { approvalAction: after.action, entityType: after.entityType, entityId: after.entityId, requestedById: after.requestedById, decidedById: input.approverId } })
    return this.view(after)
  }

  /**
   * Single-use execution of an APPROVED request. The request is claimed (APPROVED to EXECUTED) before `run` starts,
   * so two callers can never both run it. If `run` throws, the claim is released back to APPROVED so the owner can retry:
   * the action MUST therefore be idempotent. The caller is responsible for checking that the approved parameters are
   * exactly what `run` uses, and for re-validating domain rules inside `run`.
   */
  async execute<T>(input: { tenantId: string; executorId: string; approvalId: string; expectedAction: string }, run: (approval: ApprovalView) => Promise<T>): Promise<{ approval: ApprovalView; result: T }> {
    await this.expireLapsed(input.tenantId)
    const current = await this.require(input.tenantId, input.approvalId)
    if (current.action !== input.expectedAction) throw new BadRequestException('Approval is for a different action')
    if (current.status === 'EXECUTED') throw new ConflictException('Approval was already used')
    this.refuseIfExpired(current.status)
    if (current.status !== 'APPROVED') throw new ConflictException(`Approval request is ${current.status.toLowerCase()}, not approved`)
    const claimedAt = new Date()
    const claimed = await this.prisma.withTenant(input.tenantId, (tx) => tx.approvalRequest.updateMany({
      where: { id: input.approvalId, tenantId: input.tenantId, status: 'APPROVED' },
      data: { status: 'EXECUTED', executedById: input.executorId, executedAt: claimedAt },
    }))
    if (claimed.count !== 1) throw new ConflictException('Approval was already used')
    const approval = this.view(await this.require(input.tenantId, input.approvalId))
    try {
      const result = await run(approval)
      await this.audit.record({ tenantId: input.tenantId, userId: input.executorId, action: 'approval.executed', entityType: 'approval_request', entityId: approval.id, payload: { approvalAction: approval.action, entityType: approval.entityType, entityId: approval.entityId, requestedById: approval.requestedById, decidedById: approval.decidedById } })
      return { approval, result }
    } catch (error) {
      await this.prisma.withTenant(input.tenantId, (tx) => tx.approvalRequest.updateMany({
        where: { id: input.approvalId, tenantId: input.tenantId, status: 'EXECUTED', executedById: input.executorId },
        data: { status: 'APPROVED', executedById: null, executedAt: null },
      }))
      await this.audit.record({ tenantId: input.tenantId, userId: input.executorId, action: 'approval.execution_failed', entityType: 'approval_request', entityId: approval.id, payload: { approvalAction: approval.action } }).catch(() => undefined)
      throw error
    }
  }

  /** Only the maker may withdraw a pending request. */
  async cancel(input: { tenantId: string; requesterId: string; approvalId: string }): Promise<ApprovalView> {
    const current = await this.require(input.tenantId, input.approvalId)
    if (current.requestedById !== input.requesterId) throw new ForbiddenException('Only the requester can cancel a request')
    if (current.status === 'CANCELLED') return this.view(current)
    const updated = await this.prisma.withTenant(input.tenantId, (tx) => tx.approvalRequest.updateMany({ where: { id: input.approvalId, tenantId: input.tenantId, status: 'PENDING' }, data: { status: 'CANCELLED' } }))
    const after = await this.require(input.tenantId, input.approvalId)
    if (updated.count !== 1) throw new ConflictException(`Approval request is already ${after.status.toLowerCase()}`)
    await this.audit.record({ tenantId: input.tenantId, userId: input.requesterId, action: 'approval.cancelled', entityType: 'approval_request', entityId: after.id, payload: { approvalAction: after.action } })
    return this.view(after)
  }

  async get(tenantId: string, approvalId: string): Promise<ApprovalView> {
    await this.expireLapsed(tenantId)
    return this.view(await this.require(tenantId, approvalId))
  }

  async list(tenantId: string, filter: { status?: ApprovalStatus; entityType?: string; entityId?: string; limit?: number } = {}): Promise<ApprovalView[]> {
    await this.expireLapsed(tenantId)
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.findMany({
      where: { tenantId, ...(filter.status ? { status: filter.status } : {}), ...(filter.entityType ? { entityType: filter.entityType } : {}), ...(filter.entityId ? { entityId: filter.entityId } : {}) },
      orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(filter.limit ?? 50, 1), 100),
    }))
    return rows.map((r) => this.view(r))
  }

  /** Approvals for a set of entities of one type, newest first (one query, for lists that show each entity's latest request). */
  async listForEntities(tenantId: string, entityType: string, entityIds: string[]): Promise<ApprovalView[]> {
    if (entityIds.length === 0) return []
    await this.expireLapsed(tenantId)
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.findMany({ where: { tenantId, entityType, entityId: { in: entityIds } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }))
    return rows.map((r) => this.view(r))
  }

  private refuseIfExpired(status: string): void {
    if (status === 'EXPIRED') throw new ConflictException({ message: 'Approval request has expired; make a new request', code: 'APPROVAL_EXPIRED' })
  }

  /**
   * Moves requests that waited too long to EXPIRED: PENDING ones measured from the request, APPROVED ones from the decision.
   * The update is conditional on the status it read, so a decision or execution that wins the race is never overwritten.
   * Runs before every read and decision, so an expired request can neither be decided nor executed. A batch is bounded; the rest follow on the next call.
   */
  private async expireLapsed(tenantId: string, now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - approvalTtlMs())
    const lapsed = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.findMany({
      where: { tenantId, OR: [{ status: 'PENDING', createdAt: { lt: cutoff } }, { status: 'APPROVED', decidedAt: { lt: cutoff } }] },
      select: { id: true, status: true, action: true, entityType: true, entityId: true, requestedById: true, decidedById: true },
      orderBy: { createdAt: 'asc' }, take: MAX_EXPIRY_BATCH,
    }))
    for (const row of lapsed) {
      const moved = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.updateMany({ where: { id: row.id, tenantId, status: row.status }, data: { status: 'EXPIRED' } }))
      if (moved.count !== 1) continue
      await this.audit.record({ tenantId, action: 'approval.expired', entityType: 'approval_request', entityId: row.id, payload: { approvalAction: row.action, entityType: row.entityType, entityId: row.entityId, previousStatus: row.status, requestedById: row.requestedById, decidedById: row.decidedById } })
    }
  }

  private async require(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.findFirst({ where: { id, tenantId } }))
    if (!row) throw new NotFoundException('Approval request not found')
    return row
  }

  private view(row: { id: string; tenantId: string; action: string; entityType: string; entityId: string; requestId: string; status: string; requestedById: string; reason: string; beforeState: unknown; proposedState: unknown; decidedById: string | null; decidedAt: Date | null; decisionReason: string | null; executedById: string | null; executedAt: Date | null; createdAt: Date }): ApprovalView {
    return { id: row.id, tenantId: row.tenantId, action: row.action, entityType: row.entityType, entityId: row.entityId, requestId: row.requestId, status: row.status as ApprovalStatus, requestedById: row.requestedById, reason: row.reason, beforeState: row.beforeState, proposedState: row.proposedState, decidedById: row.decidedById, decidedAt: row.decidedAt, decisionReason: row.decisionReason, executedById: row.executedById, executedAt: row.executedAt, createdAt: row.createdAt }
  }
}
