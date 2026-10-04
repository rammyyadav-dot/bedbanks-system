import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { FundingReceipt } from '@prisma/client'
import {
  FUNDING_DISABLED_CODE, FUNDING_RECEIPT_STATUSES,
  type AgentFundingReceiptView, type AgentFundingView, type FundingChannel, type FundingDeclareRequest, type FundingReceiptView, type Paged,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { enumParam, idParam, pageParams, paged } from '../admin-operations/query-params'
import { duties, validateDeclaration, type Refusal, type ValidDeclaration } from './funding-policy'

type Row = FundingReceipt & { agency: { id: string; code: string; name: string } }
const AGENCY = { select: { id: true, code: true, name: true } } as const
const iso = (d: Date | null) => (d ? d.toISOString() : null)
const ledgerKey = (receiptId: string) => `funding:${receiptId}`

/** Feature flag: funding moves money, so writes stay off until the deployment opts in. Reads always work. */
export const fundingEnabled = (env: NodeJS.ProcessEnv = process.env) => env.FUNDING_ENABLED === 'true'

function refuse(r: Refusal): never {
  if (r.kind === 'duty') throw new ForbiddenException({ message: r.message, code: 'FUNDING_SEPARATION_OF_DUTIES' })
  throw new ConflictException({ message: r.message, code: 'FUNDING_INVALID_STATE' })
}

function note(name: string, value: unknown, min: number): string | null {
  if (value === undefined || value === null || value === '') {
    if (min > 0) throw new BadRequestException(`${name} is required (${min} to 500 characters)`)
    return null
  }
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be text`)
  const t = value.trim()
  if (t.length < min || t.length > 500) throw new BadRequestException(`${name} must be ${min} to 500 characters`)
  return t.length ? t : null
}

/**
 * Agency funding receipts (ADR 0028 slice 2). A receipt is declared (Admin finance staff or the agency itself), verified against the bank
 * statement by a different person, cleared by compliance when it is cash or from a third party, and posted. Posting is the only step that
 * moves money: in one transaction it opens the agency's account if needed and appends one CREDIT. Every step is audited.
 */
@Injectable()
export class FundingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  private assertEnabled() {
    if (!fundingEnabled()) throw new ServiceUnavailableException({ message: 'Funding is not enabled on this deployment.', code: FUNDING_DISABLED_CODE })
  }

  view(r: Row, me: string): FundingReceiptView {
    const post = r.status === 'VERIFIED' ? duties.post(r, me) : null
    return {
      id: r.id, agency: { id: r.agency.id, code: r.agency.code, name: r.agency.name },
      currency: r.currency, amountMinor: r.amountMinor.toString(), method: r.method, bankReference: r.bankReference, valueDate: r.valueDate.toISOString().slice(0, 10),
      payerName: r.payerName, payerType: r.payerType, notes: r.notes, status: r.status, channel: r.channel,
      complianceReviewRequired: r.complianceReviewRequired, complianceCleared: r.complianceClearedById !== null, secondApprovalRequired: r.secondApprovalRequired,
      declaredById: r.declaredById, declaredAt: r.createdAt.toISOString(),
      verifiedById: r.verifiedById, verifiedAt: iso(r.verifiedAt), verificationNote: r.verificationNote,
      complianceClearedById: r.complianceClearedById, complianceClearedAt: iso(r.complianceClearedAt), complianceNote: r.complianceNote,
      postedById: r.postedById, postedAt: iso(r.postedAt), rejectedById: r.rejectedById, rejectedAt: iso(r.rejectedAt), rejectionReason: r.rejectionReason,
      accountId: r.walletId, ledgerEntryId: r.ledgerEntryId,
      canVerify: duties.verify(r, me) === null, canClearCompliance: duties.clearCompliance(r, me) === null, canPost: r.status === 'VERIFIED' && post === null, canReject: duties.reject(r) === null,
      postBlockedReason: post?.message ?? null,
    }
  }

  private agentView(r: FundingReceipt): AgentFundingReceiptView {
    return {
      id: r.id, currency: r.currency, amountMinor: r.amountMinor.toString(), method: r.method, bankReference: r.bankReference, valueDate: r.valueDate.toISOString().slice(0, 10),
      payerName: r.payerName, payerType: r.payerType, status: r.status, declaredAt: r.createdAt.toISOString(), postedAt: iso(r.postedAt), rejectionReason: r.rejectionReason,
      complianceReviewRequired: r.complianceReviewRequired,
    }
  }

  private async load(tenantId: string, receiptId: string): Promise<Row> {
    const id = idParam('receiptId', receiptId)
    if (!id) throw new BadRequestException('receiptId is required')
    const row = await this.prisma.withTenant(tenantId, tx => tx.fundingReceipt.findFirst({ where: { id, tenantId }, include: { agency: AGENCY } }))
    if (!row) throw new NotFoundException('Funding receipt not found')
    return row
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------
  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<Paged<FundingReceiptView>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, FUNDING_RECEIPT_STATUSES)
    const agencyId = idParam('agencyId', query.agencyId)
    const where: Prisma.FundingReceiptWhereInput = { tenantId, ...(status && { status }), ...(agencyId && { agencyId }) }
    return this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([
        tx.fundingReceipt.findMany({ where, include: { agency: AGENCY }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.fundingReceipt.count({ where }),
      ])
      return paged(rows.map(r => this.view(r, me)), page, total)
    })
  }

  async get(tenantId: string, me: string, receiptId: string): Promise<FundingReceiptView> {
    return this.view(await this.load(tenantId, receiptId), me)
  }

  /** The caller's own agency and its latest receipts. A user who is not an agency member sees no agency and no receipts. */
  async agentReceipts(tenantId: string, userId: string): Promise<AgentFundingView> {
    return this.prisma.withTenant(tenantId, async tx => {
      const member = await tx.agencyMember.findFirst({ where: { tenantId, userId }, include: { agency: AGENCY } })
      if (!member) return { enabled: fundingEnabled(), agency: null, receipts: [] }
      const rows = await tx.fundingReceipt.findMany({ where: { tenantId, agencyId: member.agencyId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 })
      return { enabled: fundingEnabled(), agency: member.agency, receipts: rows.map(r => this.agentView(r)) }
    })
  }

  // ---- declare --------------------------------------------------------------------------------------------------------
  async declare(tenantId: string, userId: string, channel: FundingChannel, agencyId: string, body: unknown): Promise<Row> {
    this.assertEnabled()
    const v = validateDeclaration(body)
    const sameIntent = (r: FundingReceipt) => r.declaredById === userId && r.agencyId === agencyId && r.currency === v.currency && r.amountMinor === v.amountMinor &&
      r.method === v.method && r.bankReference === v.bankReference && r.valueDate.getTime() === v.valueDate.getTime() && r.payerName === v.payerName && r.payerType === v.payerType
    const replay = async () => {
      const existing = await this.prisma.withTenant(tenantId, tx => tx.fundingReceipt.findFirst({ where: { tenantId, requestId: v.requestId }, include: { agency: AGENCY } }))
      if (!existing) return null
      if (!sameIntent(existing)) throw new ConflictException({ message: 'This requestId was already used for a different declaration', code: 'FUNDING_REQUEST_REUSED' })
      return existing
    }
    const earlier = await replay()
    if (earlier) return earlier
    let row: Row
    try {
      row = await this.prisma.withTenant(tenantId, async tx => {
        const agency = await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true } })
        if (!agency) throw new NotFoundException('Agency not found')
        return tx.fundingReceipt.create({ data: this.createData(tenantId, userId, channel, agency.id, v), include: { agency: AGENCY } })
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const raced = await replay()
      if (raced) return raced
      throw new ConflictException({ message: 'A receipt with this bank reference, amount and currency is already declared', code: 'FUNDING_DUPLICATE_REFERENCE' })
    }
    await this.audit.record({ tenantId, userId, action: 'funding.declared', entityType: 'funding_receipt', entityId: row.id, payload: {
      agencyId: row.agencyId, currency: row.currency, amountMinor: row.amountMinor.toString(), method: row.method, payerType: row.payerType, channel,
      complianceReviewRequired: row.complianceReviewRequired, secondApprovalRequired: row.secondApprovalRequired, requestId: row.requestId,
    } })
    return row
  }

  private createData(tenantId: string, userId: string, channel: FundingChannel, agencyId: string, v: ValidDeclaration): Prisma.FundingReceiptUncheckedCreateInput {
    return {
      tenantId, agencyId, currency: v.currency, amountMinor: v.amountMinor, method: v.method, bankReference: v.bankReference, valueDate: v.valueDate,
      payerName: v.payerName, payerType: v.payerType, notes: v.notes, complianceReviewRequired: v.complianceReviewRequired, secondApprovalRequired: v.secondApprovalRequired,
      channel, requestId: v.requestId, declaredById: userId,
    }
  }

  async adminDeclare(tenantId: string, userId: string, body: unknown): Promise<FundingReceiptView> {
    const agencyId = idParam('agencyId', (body as Partial<FundingDeclareRequest> | undefined)?.agencyId)
    if (!agencyId) throw new BadRequestException('agencyId is required')
    return this.view(await this.declare(tenantId, userId, 'ADMIN', agencyId, body), userId)
  }

  /** An agency user declares for their own agency only; the agency comes from their membership, never from the request. */
  async agentDeclare(tenantId: string, userId: string, body: unknown): Promise<AgentFundingReceiptView> {
    const requested = (body as Partial<FundingDeclareRequest> | undefined)?.agencyId
    const member = await this.prisma.withTenant(tenantId, tx => tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } }))
    if (!member) throw new ForbiddenException({ message: 'Your user is not linked to an agency, so it cannot declare a payment.', code: 'FUNDING_NO_AGENCY' })
    if (requested !== undefined && requested !== member.agencyId) throw new ForbiddenException({ message: 'You can only declare payments for your own agency.', code: 'FUNDING_NO_AGENCY' })
    return this.agentView(await this.declare(tenantId, userId, 'AGENT', member.agencyId, body))
  }

  // ---- workflow steps -------------------------------------------------------------------------------------------------
  /** Locks the receipt row for the rest of the transaction and re-reads it. */
  private async lock(tx: Prisma.TransactionClient, tenantId: string, receiptId: string): Promise<Row> {
    const id = idParam('receiptId', receiptId)
    if (!id) throw new BadRequestException('receiptId is required')
    await tx.$queryRaw`SELECT "id" FROM "FundingReceipt" WHERE "id" = ${id} AND "tenant_id" = ${tenantId} FOR UPDATE`
    const row = await tx.fundingReceipt.findFirst({ where: { id, tenantId }, include: { agency: AGENCY } })
    if (!row) throw new NotFoundException('Funding receipt not found')
    return row
  }

  private async step(tenantId: string, me: string, receiptId: string, action: string, work: (tx: Prisma.TransactionClient, row: Row) => Promise<Row | null>): Promise<FundingReceiptView> {
    this.assertEnabled()
    let changed = false
    const row = await this.prisma.withTenant(tenantId, async tx => {
      const current = await this.lock(tx, tenantId, receiptId)
      const next = await work(tx, current)
      changed = next !== null
      return next ?? current
    })
    if (changed) {
      await this.audit.record({ tenantId, userId: me, action, entityType: 'funding_receipt', entityId: row.id, payload: {
        agencyId: row.agencyId, currency: row.currency, amountMinor: row.amountMinor.toString(), status: row.status,
        ...(row.ledgerEntryId && { ledgerEntryId: row.ledgerEntryId, accountId: row.walletId }),
      } })
    }
    return this.view(row, me)
  }

  verify(tenantId: string, me: string, receiptId: string, body: { note?: unknown } | undefined) {
    const text = note('note', body?.note, 0)
    return this.step(tenantId, me, receiptId, 'funding.verified', async (tx, r) => {
      if (r.status === 'VERIFIED' && r.verifiedById === me) return null
      const refusal = duties.verify(r, me); if (refusal) refuse(refusal)
      return tx.fundingReceipt.update({ where: { id: r.id }, data: { status: 'VERIFIED', verifiedById: me, verifiedAt: new Date(), verificationNote: text }, include: { agency: AGENCY } })
    })
  }

  clearCompliance(tenantId: string, me: string, receiptId: string, body: { note?: unknown } | undefined) {
    const text = note('note', body?.note, 3)
    return this.step(tenantId, me, receiptId, 'funding.compliance_cleared', async (tx, r) => {
      if (r.complianceClearedById === me) return null
      const refusal = duties.clearCompliance(r, me); if (refusal) refuse(refusal)
      return tx.fundingReceipt.update({ where: { id: r.id }, data: { complianceClearedById: me, complianceClearedAt: new Date(), complianceNote: text }, include: { agency: AGENCY } })
    })
  }

  reject(tenantId: string, me: string, receiptId: string, body: { reason?: unknown } | undefined) {
    const reason = note('reason', body?.reason, 3) as string
    return this.step(tenantId, me, receiptId, 'funding.rejected', async (tx, r) => {
      if (r.status === 'REJECTED' && r.rejectedById === me) return null
      const refusal = duties.reject(r); if (refusal) refuse(refusal)
      return tx.fundingReceipt.update({ where: { id: r.id }, data: { status: 'REJECTED', rejectedById: me, rejectedAt: new Date(), rejectionReason: reason }, include: { agency: AGENCY } })
    })
  }

  /**
   * The only step that moves money. In one transaction, under the receipt row lock and a per-account advisory lock: open the agency's
   * account in the receipt currency if it does not exist, append one CREDIT keyed `funding:<receipt id>`, and mark the receipt POSTED.
   */
  post(tenantId: string, me: string, receiptId: string) {
    return this.step(tenantId, me, receiptId, 'funding.posted', async (tx, r) => {
      if (r.status === 'POSTED' && r.postedById === me) return null
      const refusal = duties.post(r, me); if (refusal) refuse(refusal)
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agency-account:${r.agencyId}:${r.currency}`}, 0))`)
      const account = await tx.wallet.findFirst({ where: { tenantId, agencyId: r.agencyId, currency: r.currency } })
        ?? await tx.wallet.create({ data: { tenantId, agencyId: r.agencyId, currency: r.currency } })
      const entry = await tx.ledgerEntry.create({ data: {
        tenantId, walletId: account.id, type: 'CREDIT', amountMinor: r.amountMinor, currency: r.currency, idempotencyKey: ledgerKey(r.id), reference: ledgerKey(r.id),
      } })
      return tx.fundingReceipt.update({ where: { id: r.id }, data: { status: 'POSTED', postedById: me, postedAt: new Date(), walletId: account.id, ledgerEntryId: entry.id }, include: { agency: AGENCY } })
    })
  }
}
