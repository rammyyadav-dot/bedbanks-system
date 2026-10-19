import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  MARKUP_MAX_BASIS_POINTS, MARKUP_SCOPES, MARKUP_STATUSES,
  type MarkupActivationRequest, type MarkupActivationResult, type MarkupApprovalView, type MarkupDecision, type MarkupRuleCreate, type MarkupRulePage, type MarkupRuleView,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { enumParam, idParam, pageParams, textParam } from '../admin-operations/query-params'

export const MARKUP_APPROVAL_ACTION = 'markup.activate'
const ENTITY_TYPE = 'markup_rule'
const YMD = /^\d{4}-\d{2}-\d{2}$/

type RuleRow = Prisma.CommercialMarkupRuleGetPayload<{ include: { supplier: { select: { displayName: true } }; hotel: { select: { name: true } }; agency: { select: { name: true } } } }>
const INCLUDE = { supplier: { select: { displayName: true } }, hotel: { select: { name: true } }, agency: { select: { name: true } } } as const
const MAX_EXCLUSIONS = 200
const ymd = (d: Date): string => d.toISOString().slice(0, 10)

function dateParam(name: string, value: unknown): string {
  if (typeof value !== 'string' || !YMD.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new BadRequestException(`${name} must be a calendar date (YYYY-MM-DD)`)
  return value
}

/**
 * NET-rate markup rules (ADR 0018). Rules are immutable: only the status moves. DRAFT becomes ACTIVE only through an approved,
 * single-use maker-checker request, and activating a rule retires the ACTIVE rule it replaces in the same transaction.
 * Every mutation is tenant-scoped (tenant from the session) and audited.
 */
@Injectable()
export class CommercialMarkupService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService) {}

  private approvalView(a: ApprovalView | undefined, me: string): MarkupApprovalView | null {
    if (!a) return null
    return { id: a.id, status: a.status, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason, canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED' }
  }

  private view(r: RuleRow, approval: ApprovalView | undefined, me: string): MarkupRuleView {
    const open = approval && (approval.status === 'PENDING' || approval.status === 'APPROVED')
    return {
      id: r.id, scope: r.scope, supplierId: r.supplierId, supplierName: r.supplier?.displayName ?? null, hotelId: r.hotelId, hotelName: r.hotel?.name ?? null,
      agencyId: r.agencyId, agencyName: r.agency?.name ?? null, market: r.market, excludedHotelIds: r.excludedHotelIds, excludedSupplierIds: r.excludedSupplierIds,
      basisPoints: r.basisPoints, validFrom: ymd(r.validFrom), validTo: r.validTo ? ymd(r.validTo) : null, status: r.status, reason: r.reason, createdById: r.createdById,
      createdAt: r.createdAt.toISOString(), activatedAt: r.activatedAt?.toISOString() ?? null, retiredAt: r.retiredAt?.toISOString() ?? null,
      approval: this.approvalView(approval, me), canRequestActivation: r.status === 'DRAFT' && !open, canRetire: r.status !== 'RETIRED',
    }
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<MarkupRulePage> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, MARKUP_STATUSES)
    const scope = enumParam('scope', query.scope, MARKUP_SCOPES)
    const where: Prisma.CommercialMarkupRuleWhereInput = { tenantId, ...(status && { status }), ...(scope && { scope }) }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.commercialMarkupRule.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
      tx.commercialMarkupRule.count({ where }),
    ]))
    const latest = new Map<string, ApprovalView>()
    for (const a of await this.approvals.listForEntities(tenantId, ENTITY_TYPE, rows.map((r) => r.id))) if (!latest.has(a.entityId)) latest.set(a.entityId, a)
    return { items: rows.map((r) => this.view(r, latest.get(r.id), me)), page: page.page, pageSize: page.pageSize, total }
  }

  async create(tenantId: string, userId: string, body: MarkupRuleCreate): Promise<MarkupRuleView> {
    const scope = enumParam('scope', body?.scope, MARKUP_SCOPES)
    if (!scope) throw new BadRequestException('scope is required')
    const basisPoints = body.basisPoints
    if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > MARKUP_MAX_BASIS_POINTS) throw new BadRequestException(`basisPoints must be an integer from 0 to ${MARKUP_MAX_BASIS_POINTS}`)
    const validFrom = dateParam('validFrom', body.validFrom)
    const validTo = body.validTo === undefined || body.validTo === null ? null : dateParam('validTo', body.validTo)
    if (validTo !== null && validTo < validFrom) throw new BadRequestException('validTo must not be before validFrom')
    const reason = textParam('reason', body.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    const supplierId = body.supplierId === undefined ? undefined : idParam('supplierId', body.supplierId)
    const hotelId = body.hotelId === undefined ? undefined : idParam('hotelId', body.hotelId)
    if (scope === 'TENANT_DEFAULT' && (supplierId || hotelId)) throw new BadRequestException('A tenant default rule has no supplier or hotel')
    if (scope === 'SUPPLIER' && (!supplierId || hotelId)) throw new BadRequestException('A supplier rule needs a supplier and no hotel')
    if (scope === 'HOTEL' && (!hotelId || supplierId)) throw new BadRequestException('A hotel rule needs a hotel and no supplier')
    // ADR 0067 F-11: client and market tiers, and exclusions carved out of a broad rule.
    const agencyId = body.agencyId === undefined || body.agencyId === null || body.agencyId === '' ? null : idParam('agencyId', body.agencyId) ?? null
    if (body.agencyId && !agencyId) throw new BadRequestException('Invalid agencyId')
    const market = body.market === undefined || body.market === null || body.market === '' ? null : typeof body.market === 'string' && /^[A-Za-z]{2}$/.test(body.market.trim()) ? body.market.trim().toUpperCase() : undefined
    if (market === undefined) throw new BadRequestException('market must be an ISO-3166 alpha-2 country code')
    const idList = (name: string, value: unknown): string[] => {
      if (value === undefined || value === null) return []
      if (!Array.isArray(value) || value.length > MAX_EXCLUSIONS || value.some((v) => typeof v !== 'string' || !idParam(name, v))) throw new BadRequestException(`${name} must be a list of at most ${MAX_EXCLUSIONS} ids`)
      return [...new Set(value as string[])].sort()
    }
    const excludedHotelIds = idList('excludedHotelIds', body.excludedHotelIds)
    const excludedSupplierIds = idList('excludedSupplierIds', body.excludedSupplierIds)
    if (scope === 'HOTEL' && excludedHotelIds.length) throw new BadRequestException('A hotel rule cannot exclude hotels')
    if (scope === 'SUPPLIER' && excludedSupplierIds.length) throw new BadRequestException('A supplier rule cannot exclude suppliers')
    const row = await this.prisma.withTenant(tenantId, async (tx) => {
      if (supplierId && !(await tx.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } }))) throw new NotFoundException('Supplier not found')
      if (hotelId && !(await tx.hotel.findFirst({ where: { id: hotelId, tenantId }, select: { id: true } }))) throw new NotFoundException('Hotel not found')
      if (agencyId && !(await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true } }))) throw new NotFoundException('Agency not found')
      if (excludedHotelIds.length && (await tx.hotel.count({ where: { id: { in: excludedHotelIds }, tenantId } })) !== excludedHotelIds.length) throw new BadRequestException('An excluded hotel is not a hotel of this tenant')
      if (excludedSupplierIds.length && (await tx.supplier.count({ where: { id: { in: excludedSupplierIds }, tenantId } })) !== excludedSupplierIds.length) throw new BadRequestException('An excluded supplier is not a supplier of this tenant')
      return tx.commercialMarkupRule.create({
        data: { tenantId, scope, supplierId: supplierId ?? null, hotelId: hotelId ?? null, agencyId, market, excludedHotelIds, excludedSupplierIds, basisPoints, validFrom: new Date(`${validFrom}T00:00:00.000Z`), validTo: validTo ? new Date(`${validTo}T00:00:00.000Z`) : null, reason, createdById: userId },
        include: INCLUDE,
      })
    })
    await this.audit.record({ tenantId, userId, action: 'commercial.markup.created', entityType: ENTITY_TYPE, entityId: row.id, payload: { scope, supplierId: supplierId ?? null, hotelId: hotelId ?? null, agencyId, market, excludedHotelIds, excludedSupplierIds, basisPoints, validFrom, validTo } })
    return this.view(row, undefined, userId)
  }

  private async rule(tenantId: string, ruleId: string): Promise<RuleRow> {
    const id = idParam('ruleId', ruleId)
    if (!id) throw new BadRequestException('Invalid ruleId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.commercialMarkupRule.findFirst({ where: { id, tenantId }, include: INCLUDE }))
    if (!row) throw new NotFoundException('Markup rule not found')
    return row
  }

  async requestActivation(tenantId: string, userId: string, ruleId: string, body: MarkupActivationRequest): Promise<MarkupRuleView> {
    const rule = await this.rule(tenantId, ruleId)
    if (rule.status !== 'DRAFT') throw new ConflictException('Only a draft rule can be activated')
    const requestId = textParam('requestId', body?.requestId, 80)
    if (!requestId) throw new BadRequestException('requestId is required')
    const open = (await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [rule.id])).find((a) => (a.status === 'PENDING' || a.status === 'APPROVED') && a.requestId !== requestId)
    if (open) throw new ConflictException('This rule already has an open activation request')
    const current = await this.prisma.withTenant(tenantId, (tx) => tx.commercialMarkupRule.findFirst({ where: { tenantId, status: 'ACTIVE', scope: rule.scope, supplierId: rule.supplierId, hotelId: rule.hotelId, agencyId: rule.agencyId, market: rule.market }, select: { id: true, basisPoints: true } }))
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: MARKUP_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: rule.id, requestId, reason: String(body.reason ?? ''),
      beforeState: current ? { replacesRuleId: current.id, replacesBasisPoints: current.basisPoints } : {},
      proposedState: { scope: rule.scope, supplierId: rule.supplierId ?? '', hotelId: rule.hotelId ?? '', agencyId: rule.agencyId ?? '', market: rule.market ?? '', excludedHotelIds: rule.excludedHotelIds.join(','), excludedSupplierIds: rule.excludedSupplierIds.join(','), basisPoints: rule.basisPoints, validFrom: ymd(rule.validFrom), validTo: rule.validTo ? ymd(rule.validTo) : '' },
    })
    return this.view(rule, approval, userId)
  }

  private async assertRuleApproval(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== ENTITY_TYPE || a.action !== MARKUP_APPROVAL_ACTION) throw new BadRequestException('Not a markup activation approval')
    return a
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: MarkupDecision): Promise<MarkupRuleView> {
    const a = await this.assertRuleApproval(tenantId, approvalId)
    const updated = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.view(await this.rule(tenantId, a.entityId), updated, userId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<MarkupRuleView> {
    const a = await this.assertRuleApproval(tenantId, approvalId)
    const updated = await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    return this.view(await this.rule(tenantId, a.entityId), updated, userId)
  }

  /** Activates the approved rule once. The rule must still be a DRAFT exactly as it was approved; the rule it replaces is retired in the same transaction. */
  async execute(tenantId: string, userId: string, approvalId: string): Promise<MarkupActivationResult> {
    await this.assertRuleApproval(tenantId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: MARKUP_APPROVAL_ACTION }, async (approval) => {
      const p = (approval.proposedState ?? {}) as { scope?: string; supplierId?: string; hotelId?: string; agencyId?: string; market?: string; excludedHotelIds?: string; excludedSupplierIds?: string; basisPoints?: number; validFrom?: string; validTo?: string }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const rule = await tx.commercialMarkupRule.findFirst({ where: { id: approval.entityId, tenantId } })
        if (!rule) throw new NotFoundException('Markup rule not found')
        if (rule.status !== 'DRAFT') throw new ConflictException('The rule is no longer a draft')
        if (rule.scope !== p.scope || (rule.supplierId ?? '') !== (p.supplierId ?? '') || (rule.hotelId ?? '') !== (p.hotelId ?? '') || (rule.agencyId ?? '') !== (p.agencyId ?? '') || (rule.market ?? '') !== (p.market ?? '') || rule.excludedHotelIds.join(',') !== (p.excludedHotelIds ?? '') || rule.excludedSupplierIds.join(',') !== (p.excludedSupplierIds ?? '') || rule.basisPoints !== p.basisPoints || ymd(rule.validFrom) !== p.validFrom || (rule.validTo ? ymd(rule.validTo) : '') !== (p.validTo ?? '')) {
          throw new ConflictException('The rule differs from what was approved')
        }
        const now = new Date()
        const replaced = await tx.commercialMarkupRule.findFirst({ where: { tenantId, status: 'ACTIVE', scope: rule.scope, supplierId: rule.supplierId, hotelId: rule.hotelId, agencyId: rule.agencyId, market: rule.market }, select: { id: true } })
        if (replaced) await tx.commercialMarkupRule.update({ where: { id: replaced.id, tenantId }, data: { status: 'RETIRED', retiredAt: now } })
        const activated = await tx.commercialMarkupRule.update({ where: { id: rule.id, tenantId }, data: { status: 'ACTIVE', activatedAt: now }, include: INCLUDE })
        return { activated, replacedRuleId: replaced?.id ?? null }
      }).catch((error: { code?: string }) => { if (error?.code === 'P2002') throw new ConflictException('Another rule became active for this target'); throw error })
    })
    const { activated, replacedRuleId } = out.result
    await this.audit.record({ tenantId, userId, action: 'commercial.markup.activated', entityType: ENTITY_TYPE, entityId: activated.id, payload: { approvalId, basisPoints: activated.basisPoints, scope: activated.scope, replacedRuleId } })
    if (replacedRuleId) await this.audit.record({ tenantId, userId, action: 'commercial.markup.retired', entityType: ENTITY_TYPE, entityId: replacedRuleId, payload: { reason: 'superseded', byRuleId: activated.id } })
    return { approval: this.approvalView(out.approval, userId)!, rule: this.view(activated, out.approval, userId), replacedRuleId }
  }

  /** Retires a draft or active rule. Retiring an ACTIVE rule makes NET rates without another rule unsellable, which is the safe direction. */
  async retire(tenantId: string, userId: string, ruleId: string): Promise<MarkupRuleView> {
    const rule = await this.rule(tenantId, ruleId)
    if (rule.status === 'RETIRED') return this.view(rule, undefined, userId)
    const updated = await this.prisma.withTenant(tenantId, (tx) => tx.commercialMarkupRule.updateMany({ where: { id: rule.id, tenantId, status: { not: 'RETIRED' } }, data: { status: 'RETIRED', retiredAt: new Date() } }))
    if (updated.count === 1) await this.audit.record({ tenantId, userId, action: 'commercial.markup.retired', entityType: ENTITY_TYPE, entityId: rule.id, payload: { from: rule.status, basisPoints: rule.basisPoints, scope: rule.scope } })
    return this.view(await this.rule(tenantId, rule.id), undefined, userId)
  }
}
