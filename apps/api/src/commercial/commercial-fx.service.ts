import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { FxRate, Prisma } from '@prisma/client'
import {
  FX_MAX_BUFFER_BP, FX_RATE_STATUSES,
  type FxActivationResult, type FxRateCreate, type FxRatePage, type FxRateView, type MarkupActivationRequest, type MarkupApprovalView, type MarkupDecision,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { enumParam, idParam, pageParams, textParam } from '../admin-operations/query-params'
import { enabledSettlementCurrencies } from '../agent/currency'
import { RATE_SCALE, effectiveRateDecimal, parseRate } from '../supply/fx'

export const FX_APPROVAL_ACTION = 'fx.activate'
const ENTITY_TYPE = 'fx_rate'

const rateDecimal = (scaled: bigint): string => `${scaled / RATE_SCALE}.${(scaled % RATE_SCALE).toString().padStart(8, '0')}`

/**
 * Controlled FX rates (ADR 0067, F-12). Same lifecycle as markup rules: rates are immutable, DRAFT becomes ACTIVE only through an approved,
 * single-use maker-checker request, and activating a rate retires the ACTIVE rate of the same pair in the same transaction.
 * Every mutation is tenant-scoped (tenant from the session) and audited.
 */
@Injectable()
export class CommercialFxService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService) {}

  private approvalView(a: ApprovalView | undefined, me: string): MarkupApprovalView | null {
    if (!a) return null
    return { id: a.id, status: a.status, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason, canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED' }
  }

  private view(r: FxRate, approval: ApprovalView | undefined, me: string): FxRateView {
    const open = approval && (approval.status === 'PENDING' || approval.status === 'APPROVED')
    return {
      id: r.id, baseCurrency: r.baseCurrency, quoteCurrency: r.quoteCurrency, rate: rateDecimal(r.rateScaled), bufferBp: r.bufferBp, effectiveRate: effectiveRateDecimal(r),
      status: r.status, reason: r.reason, createdById: r.createdById, createdAt: r.createdAt.toISOString(), activatedAt: r.activatedAt?.toISOString() ?? null, retiredAt: r.retiredAt?.toISOString() ?? null,
      approval: this.approvalView(approval, me), canRequestActivation: r.status === 'DRAFT' && !open, canRetire: r.status !== 'RETIRED',
    }
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<FxRatePage> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, FX_RATE_STATUSES)
    const where: Prisma.FxRateWhereInput = { tenantId, ...(status && { status }) }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.fxRate.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
      tx.fxRate.count({ where }),
    ]))
    const latest = new Map<string, ApprovalView>()
    for (const a of await this.approvals.listForEntities(tenantId, ENTITY_TYPE, rows.map((r) => r.id))) if (!latest.has(a.entityId)) latest.set(a.entityId, a)
    return { items: rows.map((r) => this.view(r, latest.get(r.id), me)), page: page.page, pageSize: page.pageSize, total }
  }

  async create(tenantId: string, userId: string, body: FxRateCreate): Promise<FxRateView> {
    const enabled = enabledSettlementCurrencies() as readonly string[]
    const currency = (name: string, raw: unknown): string => {
      const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
      if (!enabled.includes(value)) throw new BadRequestException({ message: `${name} must be an enabled currency (${enabled.join(', ')})`, code: 'CURRENCY_NOT_ENABLED' })
      return value
    }
    const baseCurrency = currency('baseCurrency', body?.baseCurrency)
    const quoteCurrency = currency('quoteCurrency', body?.quoteCurrency)
    if (baseCurrency === quoteCurrency) throw new BadRequestException('baseCurrency and quoteCurrency must differ')
    const rateScaled = parseRate(body.rate)
    if (rateScaled === null) throw new BadRequestException('rate must be a positive decimal string with at most eight decimal places')
    const bufferBp = body.bufferBp ?? 0
    if (!Number.isSafeInteger(bufferBp) || bufferBp < 0 || bufferBp > FX_MAX_BUFFER_BP) throw new BadRequestException(`bufferBp must be an integer from 0 to ${FX_MAX_BUFFER_BP}`)
    const reason = textParam('reason', body.reason, 500)
    if (!reason || reason.length < 3) throw new BadRequestException('A reason is required')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.fxRate.create({ data: { tenantId, baseCurrency, quoteCurrency, rateScaled, bufferBp, reason, createdById: userId } }))
    await this.audit.record({ tenantId, userId, action: 'commercial.fx.created', entityType: ENTITY_TYPE, entityId: row.id, payload: { baseCurrency, quoteCurrency, rate: rateDecimal(rateScaled), bufferBp } })
    return this.view(row, undefined, userId)
  }

  private async rate(tenantId: string, rateId: string): Promise<FxRate> {
    const id = idParam('rateId', rateId)
    if (!id) throw new BadRequestException('Invalid rateId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.fxRate.findFirst({ where: { id, tenantId } }))
    if (!row) throw new NotFoundException('FX rate not found')
    return row
  }

  async requestActivation(tenantId: string, userId: string, rateId: string, body: MarkupActivationRequest): Promise<FxRateView> {
    const rate = await this.rate(tenantId, rateId)
    if (rate.status !== 'DRAFT') throw new ConflictException('Only a draft rate can be activated')
    const requestId = textParam('requestId', body?.requestId, 80)
    if (!requestId) throw new BadRequestException('requestId is required')
    const open = (await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [rate.id])).find((a) => (a.status === 'PENDING' || a.status === 'APPROVED') && a.requestId !== requestId)
    if (open) throw new ConflictException('This rate already has an open activation request')
    const current = await this.prisma.withTenant(tenantId, (tx) => tx.fxRate.findFirst({ where: { tenantId, status: 'ACTIVE', baseCurrency: rate.baseCurrency, quoteCurrency: rate.quoteCurrency } }))
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: FX_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: rate.id, requestId, reason: String(body.reason ?? ''),
      beforeState: current ? { replacesRateId: current.id, replacesRate: rateDecimal(current.rateScaled), replacesBufferBp: current.bufferBp } : {},
      proposedState: { baseCurrency: rate.baseCurrency, quoteCurrency: rate.quoteCurrency, rate: rateDecimal(rate.rateScaled), bufferBp: rate.bufferBp },
    })
    return this.view(rate, approval, userId)
  }

  private async assertFxApproval(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== ENTITY_TYPE || a.action !== FX_APPROVAL_ACTION) throw new BadRequestException('Not an FX rate activation approval')
    return a
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: MarkupDecision): Promise<FxRateView> {
    const a = await this.assertFxApproval(tenantId, approvalId)
    const updated = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.view(await this.rate(tenantId, a.entityId), updated, userId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<FxRateView> {
    const a = await this.assertFxApproval(tenantId, approvalId)
    const updated = await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    return this.view(await this.rate(tenantId, a.entityId), updated, userId)
  }

  /** Activates the approved rate once. It must still be a DRAFT exactly as approved; the rate it replaces is retired in the same transaction. */
  async execute(tenantId: string, userId: string, approvalId: string): Promise<FxActivationResult> {
    await this.assertFxApproval(tenantId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: FX_APPROVAL_ACTION }, async (approval) => {
      const p = (approval.proposedState ?? {}) as { baseCurrency?: string; quoteCurrency?: string; rate?: string; bufferBp?: number }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const rate = await tx.fxRate.findFirst({ where: { id: approval.entityId, tenantId } })
        if (!rate) throw new NotFoundException('FX rate not found')
        if (rate.status !== 'DRAFT') throw new ConflictException('The rate is no longer a draft')
        if (rate.baseCurrency !== p.baseCurrency || rate.quoteCurrency !== p.quoteCurrency || rateDecimal(rate.rateScaled) !== p.rate || rate.bufferBp !== p.bufferBp) throw new ConflictException('The rate differs from what was approved')
        const now = new Date()
        const replaced = await tx.fxRate.findFirst({ where: { tenantId, status: 'ACTIVE', baseCurrency: rate.baseCurrency, quoteCurrency: rate.quoteCurrency }, select: { id: true } })
        if (replaced) await tx.fxRate.update({ where: { id: replaced.id, tenantId }, data: { status: 'RETIRED', retiredAt: now } })
        const activated = await tx.fxRate.update({ where: { id: rate.id, tenantId }, data: { status: 'ACTIVE', activatedAt: now } })
        return { activated, replacedRateId: replaced?.id ?? null }
      }).catch((error: { code?: string }) => { if (error?.code === 'P2002') throw new ConflictException('Another rate became active for this pair'); throw error })
    })
    const { activated, replacedRateId } = out.result
    await this.audit.record({ tenantId, userId, action: 'commercial.fx.activated', entityType: ENTITY_TYPE, entityId: activated.id, payload: { approvalId, baseCurrency: activated.baseCurrency, quoteCurrency: activated.quoteCurrency, rate: rateDecimal(activated.rateScaled), bufferBp: activated.bufferBp, replacedRateId } })
    if (replacedRateId) await this.audit.record({ tenantId, userId, action: 'commercial.fx.retired', entityType: ENTITY_TYPE, entityId: replacedRateId, payload: { reason: 'superseded', byRateId: activated.id } })
    return { approval: this.approvalView(out.approval, userId)!, rate: this.view(activated, out.approval, userId), replacedRateId }
  }

  /** Retires a draft or active rate. Retiring an ACTIVE rate stops contracts in its base currency being offered in its quote currency: the safe direction. */
  async retire(tenantId: string, userId: string, rateId: string): Promise<FxRateView> {
    const rate = await this.rate(tenantId, rateId)
    if (rate.status === 'RETIRED') return this.view(rate, undefined, userId)
    const updated = await this.prisma.withTenant(tenantId, (tx) => tx.fxRate.updateMany({ where: { id: rate.id, tenantId, status: { not: 'RETIRED' } }, data: { status: 'RETIRED', retiredAt: new Date() } }))
    if (updated.count === 1) await this.audit.record({ tenantId, userId, action: 'commercial.fx.retired', entityType: ENTITY_TYPE, entityId: rate.id, payload: { from: rate.status, baseCurrency: rate.baseCurrency, quoteCurrency: rate.quoteCurrency } })
    return this.view(await this.rate(tenantId, rate.id), undefined, userId)
  }
}
