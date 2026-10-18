import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { ContractApprovalView, ContractLifecycleView, ContractVersionView } from '@bedbanks/contracts'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { PrismaService } from '../database/prisma.service'
import { SupplyService } from './supply.service'
import {
  headerOf, activationAllowedFrom, amendmentProblems, applyAmendment, assessContractActivation, lifecycleTarget, nextVersion, normaliseAmendment, termsEditable, termsFingerprint,
  type ContractAmendment, type ContractLifecycleAction, type ContractTerms, type PlanFacts,
} from './contract-lifecycle'

/** The permission-catalogue key (S3, approval-only, refines supply.contracts.manage). */
export const CONTRACT_APPROVAL_ACTION = 'contract.approve'
const ENTITY_TYPE = 'contract'
const OPEN = new Set(['PENDING', 'APPROVED'])

type Kind = 'ACTIVATE' | 'AMEND'
interface Bound { kind?: Kind; fingerprint?: string; afterFingerprint?: string; changes?: ContractAmendment; code?: string }
const bound = (approval: ApprovalView): Bound => ((approval.proposedState ?? {}) as Bound)
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const todayUtc = (now: Date) => now.toISOString().slice(0, 10)

const contractInclude = {
  supplier: { select: { id: true, status: true, displayName: true } },
  supplierHotelMapping: { select: { id: true, status: true, hotelId: true } },
  cancellationPolicies: true, childPolicies: true, leadTimeRules: true,
  ratePlans: { select: { code: true, status: true, currency: true, refundable: true, cancellationPolicySet: true, validFrom: true, validTo: true } },
} as const
type LoadedContract = Prisma.ContractGetPayload<{ include: typeof contractInclude }>

/** The reviewed terms of a loaded contract, in the canonical shape the fingerprint is taken over. */
export function termsOf(c: LoadedContract): ContractTerms {
  const lead = Array.isArray(c.leadTimeRules) ? c.leadTimeRules[0] : c.leadTimeRules
  return {
    code: c.code, supplierId: c.supplierId, supplierHotelMappingId: c.supplierHotelMappingId, validFrom: day(c.validFrom)!, validTo: day(c.validTo)!,
    settlementCurrency: c.settlementCurrency, salesMarkets: Array.isArray(c.salesMarkets) ? (c.salesMarkets as string[]) : [], nationalities: Array.isArray(c.nationalities) ? (c.nationalities as string[]) : [],
    paymentPolicyRef: c.paymentPolicyRef,
    cancellationPolicies: c.cancellationPolicies.map((p) => ({ policySet: p.policySet, daysBeforeCheckin: p.daysBeforeCheckin, penaltyPercent: p.penaltyPercent, penaltyMinor: p.penaltyMinor?.toString() ?? null, currency: p.currency })),
    childPolicies: c.childPolicies.map((p) => ({ minAge: p.minAge, maxAge: p.maxAge, extraBedAllowed: p.extraBedAllowed, supplementMinor: p.supplementMinor?.toString() ?? null, currency: p.currency })),
    leadTimeRule: lead ? { minLeadHours: lead.minLeadHours, maxLeadDays: lead.maxLeadDays } : null,
    header: headerOf(c),
  }
}

const plansOf = (c: LoadedContract): PlanFacts[] => c.ratePlans.map((p) => ({ code: p.code, status: p.status, currency: p.currency, refundable: p.refundable, cancellationPolicySet: p.cancellationPolicySet, validFrom: day(p.validFrom), validTo: day(p.validTo) }))

/**
 * Contract maker-checker and versioning (ADR 0067, F-01).
 *
 * Request -> decide by a DIFFERENT user -> execute once, bound to the SHA-256 of the exact terms reviewed (header and every policy).
 * Activation readiness and amendment consistency are re-run inside the executing transaction, under a row lock on the contract, so an
 * approval never waives a check. Every executed change appends an immutable ContractVersion snapshot and an audit event.
 */
@Injectable()
export class ContractApprovalService {
  constructor(private readonly prisma: PrismaService, private readonly approvals: ApprovalService, private readonly supply: SupplyService) {}

  private async load(tx: Prisma.TransactionClient, tenantId: string, contractId: string): Promise<LoadedContract> {
    const contract = await tx.contract.findFirst({ where: { id: contractId, tenantId }, include: contractInclude })
    if (!contract) throw new NotFoundException('Contract not found')
    return contract
  }

  private view(approval: ApprovalView, me: string, currentFingerprint: string | null): ContractApprovalView {
    const state = bound(approval)
    const isRequester = approval.requestedById === me
    return {
      id: approval.id, contractId: approval.entityId, kind: state.kind ?? 'ACTIVATE', status: approval.status, reason: approval.reason, requestedById: approval.requestedById,
      decidedById: approval.decidedById, decisionReason: approval.decisionReason, decidedAt: approval.decidedAt?.toISOString() ?? null, executedAt: approval.executedAt?.toISOString() ?? null,
      createdAt: approval.createdAt.toISOString(), changes: (state.changes ?? null) as ContractApprovalView['changes'],
      changedSinceRequest: currentFingerprint !== null && state.fingerprint !== currentFingerprint,
      isRequester, canDecide: approval.status === 'PENDING' && !isRequester, canCancel: approval.status === 'PENDING' && isRequester, canExecute: approval.status === 'APPROVED',
    }
  }

  /** Status, version, fingerprint, activation readiness, the open request and the history: everything the contract page needs. */
  async lifecycle(tenantId: string, userId: string, contractId: string, now = new Date()): Promise<ContractLifecycleView> {
    await this.supply.assertPermission(tenantId, userId, 'supply.contracts.read')
    const { contract, versions } = await this.prisma.withTenant(tenantId, async (tx) => ({
      contract: await this.load(tx, tenantId, contractId),
      versions: await tx.contractVersion.findMany({ where: { tenantId, contractId }, orderBy: { version: 'desc' } }),
    }))
    const terms = termsOf(contract)
    const fingerprint = termsFingerprint(terms)
    const readiness = assessContractActivation({ today: todayUtc(now), status: contract.status, terms, supplierStatus: contract.supplier.status, mappingStatus: contract.supplierHotelMapping?.status ?? null, plans: plansOf(contract) })
    const requests = (await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [contractId])).filter((a) => a.action === CONTRACT_APPROVAL_ACTION)
    const open = requests.find((a) => OPEN.has(a.status))
    return {
      contractId, status: contract.status, version: contract.version, updatedAt: contract.updatedAt.toISOString(), fingerprint, termsEditable: termsEditable(contract.status),
      readiness, openRequest: open ? this.view(open, userId, fingerprint) : null,
      recentRequests: requests.slice(0, 10).map((a) => this.view(a, userId, fingerprint)),
      versions: versions.map((v): ContractVersionView => ({ version: v.version, kind: v.kind, fingerprint: v.fingerprint, requestedById: v.requestedById, approvedById: v.approvedById, appliedById: v.appliedById, reason: v.reason, createdAt: v.createdAt.toISOString(), terms: v.terms as unknown as ContractVersionView['terms'] })),
    }
  }

  /** Single-actor housekeeping and suspension. Activation is never reachable here. */
  async transition(tenantId: string, userId: string, contractId: string, action: ContractLifecycleAction, body: { expectedUpdatedAt?: unknown; reason?: unknown }, requestId?: string) {
    await this.supply.assertPermission(tenantId, userId, 'supply.contracts.manage')
    const expected = typeof body?.expectedUpdatedAt === 'string' ? new Date(body.expectedUpdatedAt) : null
    if (!expected || Number.isNaN(expected.getTime())) throw new BadRequestException('expectedUpdatedAt is required')
    const reason = text(body?.reason, 500)
    if (action === 'suspend' && !reason) throw new BadRequestException('A reason is required to suspend a contract')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const contract = await this.load(tx, tenantId, contractId)
      const to = lifecycleTarget(action, contract.status)
      if (!to) throw new ConflictException({ code: 'CONTRACT_TRANSITION_NOT_ALLOWED', message: `A ${contract.status} contract cannot be ${action === 'submit' ? 'submitted for review' : action === 'return' ? 'returned to draft' : 'suspended'}.` })
      const moved = await tx.contract.updateMany({ where: { id: contract.id, tenantId, updatedAt: expected }, data: { status: to } })
      if (moved.count !== 1) throw new ConflictException({ code: 'CONTRACT_CHANGED', message: 'The contract changed since it was loaded. Reload and try again.' })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.contract.status_changed', entityType: 'contract', entityId: contract.id, payload: { outcome: 'allowed', requestId: requestId ?? null, from: contract.status, to, reason: reason || null, version: contract.version } } })
      return { contractId: contract.id, status: to }
    })
  }

  async requestActivation(tenantId: string, userId: string, contractId: string, body: { requestId?: unknown; reason?: unknown; expectedFingerprint?: unknown }, httpRequestId?: string): Promise<ContractApprovalView> {
    return this.file(tenantId, userId, contractId, 'ACTIVATE', body, undefined, httpRequestId)
  }

  async requestAmendment(tenantId: string, userId: string, contractId: string, body: { requestId?: unknown; reason?: unknown; expectedFingerprint?: unknown; changes?: unknown }, httpRequestId?: string): Promise<ContractApprovalView> {
    const parsed = normaliseAmendment(body?.changes)
    if (!parsed.changes) throw new BadRequestException({ code: 'CONTRACT_AMENDMENT_INVALID', message: 'The amendment is not valid.', details: parsed.errors })
    return this.file(tenantId, userId, contractId, 'AMEND', body, parsed.changes, httpRequestId)
  }

  private async file(tenantId: string, userId: string, contractId: string, kind: Kind, body: { requestId?: unknown; reason?: unknown; expectedFingerprint?: unknown }, changes: ContractAmendment | undefined, httpRequestId?: string): Promise<ContractApprovalView> {
    await this.supply.assertPermission(tenantId, userId, 'supply.contracts.manage')
    const requestId = text(body?.requestId, 80)
    if (requestId.length < 8) throw new BadRequestException('requestId is required (8 to 80 characters)')
    if (typeof body?.expectedFingerprint !== 'string') throw new BadRequestException('expectedFingerprint is required')
    const contract = await this.prisma.withTenant(tenantId, (tx) => this.load(tx, tenantId, contractId))
    const terms = termsOf(contract)
    const fingerprint = termsFingerprint(terms)
    if (fingerprint !== body.expectedFingerprint) throw new ConflictException({ code: 'CONTRACT_CHANGED', message: 'The contract terms changed since they were loaded. Reload and review before requesting.' })
    let afterFingerprint: string | undefined
    if (kind === 'ACTIVATE') {
      const readiness = assessContractActivation({ today: todayUtc(new Date()), status: contract.status, terms, supplierStatus: contract.supplier.status, mappingStatus: contract.supplierHotelMapping?.status ?? null, plans: plansOf(contract) })
      if (!readiness.ready) throw new ConflictException({ code: 'CONTRACT_NOT_READY', message: 'Contract activation checks failed.', details: readiness.checks.filter((c) => !c.ok) })
    } else {
      if (contract.status !== 'ACTIVE') throw new ConflictException({ code: 'CONTRACT_AMENDMENT_NOT_NEEDED', message: `A ${contract.status} contract is edited directly; amendments are for ACTIVE contracts.` })
      const after = applyAmendment(terms, changes!)
      const problems = amendmentProblems(terms, after, plansOf(contract))
      if (problems.length) throw new ConflictException({ code: 'CONTRACT_AMENDMENT_CONFLICT', message: problems.join(' '), details: problems })
      afterFingerprint = termsFingerprint(after)
    }
    // One open request per contract. A request bound to terms that no longer exist can never be applied: it is superseded, not left blocking.
    for (const open of await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [contractId])) {
      if (open.action !== CONTRACT_APPROVAL_ACTION || !OPEN.has(open.status) || open.requestId === requestId) continue
      if (bound(open).fingerprint === fingerprint) throw new ConflictException({ code: 'CONTRACT_APPROVAL_OPEN', message: 'This contract already has an open request. Decide or cancel it first.' })
      const superseded = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.updateMany({ where: { id: open.id, tenantId, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } }))
      if (superseded.count === 1) await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'supply.contract.request_superseded', entityType: ENTITY_TYPE, entityId: contractId, payload: { outcome: 'allowed', approvalId: open.id, requestId: httpRequestId ?? null } } }))
    }
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: CONTRACT_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: contractId, requestId, reason: String(body.reason ?? ''),
      beforeState: { status: contract.status, version: contract.version },
      proposedState: { kind, fingerprint, code: contract.code, ...(afterFingerprint ? { afterFingerprint } : {}), ...(changes ? { changes: changes as Record<string, unknown> } : {}) },
    })
    return this.view(approval, userId, fingerprint)
  }

  private async mine(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const approval = await this.approvals.get(tenantId, approvalId).catch(() => { throw new NotFoundException('Contract approval not found') })
    if (approval.entityType !== ENTITY_TYPE || approval.action !== CONTRACT_APPROVAL_ACTION) throw new NotFoundException('Contract approval not found')
    return approval
  }

  private async currentFingerprint(tenantId: string, contractId: string): Promise<string> {
    return termsFingerprint(termsOf(await this.prisma.withTenant(tenantId, (tx) => this.load(tx, tenantId, contractId))))
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: { reason?: unknown }): Promise<ContractApprovalView> {
    await this.supply.assertPermission(tenantId, userId, 'supply.contracts.manage')
    const approval = await this.mine(tenantId, approvalId)
    const fingerprint = await this.currentFingerprint(tenantId, approval.entityId)
    // A checker signs off on what is there now. If the terms moved since the request, refuse: the maker files again.
    if (decision === 'APPROVED' && approval.status === 'PENDING' && bound(approval).fingerprint !== fingerprint) throw new ConflictException({ code: 'CONTRACT_CHANGED_SINCE_REQUEST', message: 'The contract changed after this request was filed, so it cannot be approved. Ask for a new request.' })
    const updated = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.view(updated, userId, fingerprint)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<ContractApprovalView> {
    await this.supply.assertPermission(tenantId, userId, 'supply.contracts.manage')
    const approval = await this.mine(tenantId, approvalId)
    const cancelled = await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    return this.view(cancelled, userId, await this.currentFingerprint(tenantId, approval.entityId))
  }

  /** Applies the approved request once, under a row lock, re-checking the bound terms and every rule. */
  async execute(tenantId: string, userId: string, approvalId: string, httpRequestId?: string): Promise<{ approval: ContractApprovalView; contractId: string; status: string; version: number }> {
    await this.supply.assertPermission(tenantId, userId, 'supply.contracts.manage')
    const found = await this.mine(tenantId, approvalId)
    if (!bound(found).fingerprint || !bound(found).kind) throw new NotFoundException('Approval carries no bound terms')
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: CONTRACT_APPROVAL_ACTION }, async (approval) => {
      const state = bound(approval)
      if (!approval.decidedById) throw new ConflictException('Approval has no approver')
      return this.prisma.withTenant(tenantId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Contract" WHERE id = ${approval.entityId} AND tenant_id = ${tenantId} FOR UPDATE`
        const contract = await this.load(tx, tenantId, approval.entityId)
        const before = termsOf(contract)
        const fingerprint = termsFingerprint(before)
        if (fingerprint !== state.fingerprint) throw new ConflictException({ code: 'CONTRACT_CHANGED_SINCE_APPROVAL', message: 'The contract changed after this request was approved. File a new request.' })
        const last = await tx.contractVersion.findFirst({ where: { tenantId, contractId: contract.id }, orderBy: { version: 'desc' }, select: { version: true, fingerprint: true } })
        let after = before
        let status = contract.status
        let header: Prisma.ContractUpdateManyMutationInput = {}
        if (state.kind === 'ACTIVATE') {
          if (!activationAllowedFrom(contract.status)) throw new ConflictException({ code: 'CONTRACT_TRANSITION_NOT_ALLOWED', message: `A ${contract.status} contract cannot be activated.` })
          const readiness = assessContractActivation({ today: todayUtc(new Date()), status: contract.status, terms: before, supplierStatus: contract.supplier.status, mappingStatus: contract.supplierHotelMapping?.status ?? null, plans: plansOf(contract) })
          if (!readiness.ready) throw new ConflictException({ code: 'CONTRACT_NOT_READY', message: 'Contract activation checks failed.', details: readiness.checks.filter((c) => !c.ok) })
          status = 'ACTIVE'
        } else {
          if (contract.status !== 'ACTIVE') throw new ConflictException({ code: 'CONTRACT_AMENDMENT_NOT_NEEDED', message: `The contract is ${contract.status}; amendments apply to ACTIVE contracts only.` })
          const parsed = normaliseAmendment(state.changes)
          if (!parsed.changes) throw new ConflictException({ code: 'CONTRACT_AMENDMENT_INVALID', message: 'The approved amendment is no longer valid.', details: parsed.errors })
          after = applyAmendment(before, parsed.changes)
          const problems = amendmentProblems(before, after, plansOf(contract))
          if (problems.length) throw new ConflictException({ code: 'CONTRACT_AMENDMENT_CONFLICT', message: problems.join(' '), details: problems })
          header = await this.applyTerms(tx, contract, parsed.changes, after)
        }
        const afterFingerprint = termsFingerprint(after)
        const version = nextVersion(contract.version, last, afterFingerprint, state.kind === 'AMEND' ? 'AMENDMENT' : 'ACTIVATION')
        const moved = await tx.contract.updateMany({ where: { id: contract.id, tenantId, updatedAt: contract.updatedAt }, data: { ...header, status, version } })
        if (moved.count !== 1) throw new ConflictException({ code: 'CONTRACT_CHANGED', message: 'The contract changed while the request was applied. Try again.' })
        await tx.contractVersion.create({ data: {
          tenantId, contractId: contract.id, version, kind: state.kind === 'AMEND' ? 'AMENDMENT' : 'ACTIVATION', terms: after as unknown as Prisma.InputJsonValue, fingerprint: afterFingerprint,
          approvalId: approval.id, requestedById: approval.requestedById, approvedById: approval.decidedById!, appliedById: userId, reason: approval.reason,
        } })
        const changed = state.kind === 'AMEND' ? Object.keys(state.changes ?? {}) : []
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: state.kind === 'AMEND' ? 'supply.contract.amended' : 'supply.contract.status_changed', entityType: 'contract', entityId: contract.id,
          payload: { outcome: 'allowed', requestId: httpRequestId ?? null, approvalId: approval.id, requestedById: approval.requestedById, approvedById: approval.decidedById, from: contract.status, to: status, fromVersion: contract.version, toVersion: version, changedTerms: changed, fromFingerprint: fingerprint, toFingerprint: afterFingerprint } } })
        return { status, version }
      })
    })
    return { approval: this.view(out.approval, userId, null), contractId: out.approval.entityId, status: out.result.status, version: out.result.version }
  }

  /** Replaces the policy sets an approved amendment names and returns its header fields for the one guarded contract write. Only called inside `execute`. */
  private async applyTerms(tx: Prisma.TransactionClient, contract: LoadedContract, changes: ContractAmendment, after: ContractTerms): Promise<Prisma.ContractUpdateManyMutationInput> {
    const header: Prisma.ContractUpdateManyMutationInput = {}
    if (changes.code !== undefined) header.code = after.code
    if (changes.validFrom !== undefined) header.validFrom = new Date(`${after.validFrom}T00:00:00.000Z`)
    if (changes.validTo !== undefined) header.validTo = new Date(`${after.validTo}T00:00:00.000Z`)
    if (changes.settlementCurrency !== undefined) header.settlementCurrency = after.settlementCurrency
    if (changes.salesMarkets !== undefined) header.salesMarkets = after.salesMarkets
    if (changes.nationalities !== undefined) header.nationalities = after.nationalities
    if (changes.paymentPolicyRef !== undefined) header.paymentPolicyRef = after.paymentPolicyRef
    if (changes.header !== undefined) {
      const h = after.header
      Object.assign(header, { rateType: h.rateType, commissionBp: h.commissionBp, paymentTermsDays: h.paymentTermsDays, signedAt: h.signedAt === null ? null : new Date(`${h.signedAt}T00:00:00.000Z`), signedDocumentRef: h.signedDocumentRef, allotmentType: h.allotmentType, minStayMode: h.minStayMode })
    }
    if (changes.cancellationPolicies !== undefined) {
      await tx.cancellationPolicy.deleteMany({ where: { contractId: contract.id } })
      if (after.cancellationPolicies.length) await tx.cancellationPolicy.createMany({ data: after.cancellationPolicies.map((p) => ({ contractId: contract.id, policySet: p.policySet, daysBeforeCheckin: p.daysBeforeCheckin, penaltyPercent: p.penaltyPercent, penaltyMinor: p.penaltyMinor === null ? null : BigInt(p.penaltyMinor), currency: p.currency })) })
    }
    if (changes.childPolicies !== undefined) {
      await tx.childPolicy.deleteMany({ where: { contractId: contract.id } })
      if (after.childPolicies.length) await tx.childPolicy.createMany({ data: after.childPolicies.map((p) => ({ contractId: contract.id, minAge: p.minAge, maxAge: p.maxAge, extraBedAllowed: p.extraBedAllowed, supplementMinor: p.supplementMinor === null ? null : BigInt(p.supplementMinor), currency: p.currency })) })
    }
    if (changes.leadTimeRule !== undefined) {
      if (after.leadTimeRule === null) await tx.bookingLeadTimeRule.deleteMany({ where: { contractId: contract.id } })
      else await tx.bookingLeadTimeRule.upsert({ where: { contractId: contract.id }, update: after.leadTimeRule, create: { contractId: contract.id, ...after.leadTimeRule } })
    }
    return header
  }
}
