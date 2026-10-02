import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { FORBIDDEN_PERMISSION_KEYS, permissionCatalogue } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { sanitizeAuditPayload } from '../agent/audit-payload'

export type ApprovalDecision = 'APPROVED' | 'REJECTED'
export type ApprovalStatus = 'PENDING' | ApprovalDecision | 'CANCELLED'

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
    const current = await this.require(input.tenantId, input.approvalId)
    if (current.requestedById === input.approverId) {
      await this.audit.record({ tenantId: input.tenantId, userId: input.approverId, action: 'approval.denied', entityType: 'approval_request', entityId: current.id, payload: { approvalAction: current.action, reason: 'SELF_APPROVAL' } })
      throw new ForbiddenException('A request cannot be decided by the user who made it')
    }
    if (current.status !== 'PENDING') {
      if (current.status === input.decision && current.decidedById === input.approverId) return this.view(current)
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
      throw new ConflictException(`Approval request is already ${after.status.toLowerCase()}`)
    }
    await this.audit.record({ tenantId: input.tenantId, userId: input.approverId, action: `approval.${input.decision.toLowerCase()}`, entityType: 'approval_request', entityId: after.id, payload: { approvalAction: after.action, entityType: after.entityType, entityId: after.entityId, requestedById: after.requestedById } })
    return this.view(after)
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
    return this.view(await this.require(tenantId, approvalId))
  }

  async list(tenantId: string, filter: { status?: ApprovalStatus; entityType?: string; entityId?: string; limit?: number } = {}): Promise<ApprovalView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.findMany({
      where: { tenantId, ...(filter.status ? { status: filter.status } : {}), ...(filter.entityType ? { entityType: filter.entityType } : {}), ...(filter.entityId ? { entityId: filter.entityId } : {}) },
      orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(filter.limit ?? 50, 1), 100),
    }))
    return rows.map((r) => this.view(r))
  }

  private async require(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.findFirst({ where: { id, tenantId } }))
    if (!row) throw new NotFoundException('Approval request not found')
    return row
  }

  private view(row: { id: string; tenantId: string; action: string; entityType: string; entityId: string; requestId: string; status: string; requestedById: string; reason: string; beforeState: unknown; proposedState: unknown; decidedById: string | null; decidedAt: Date | null; decisionReason: string | null; createdAt: Date }): ApprovalView {
    return { id: row.id, tenantId: row.tenantId, action: row.action, entityType: row.entityType, entityId: row.entityId, requestId: row.requestId, status: row.status as ApprovalStatus, requestedById: row.requestedById, reason: row.reason, beforeState: row.beforeState, proposedState: row.proposedState, decidedById: row.decidedById, decidedAt: row.decidedAt, decisionReason: row.decisionReason, createdAt: row.createdAt }
  }
}
