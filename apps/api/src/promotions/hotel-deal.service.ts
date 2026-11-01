import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  HOTEL_DEAL_APPROVAL_ACTION, HOTEL_DEAL_STATUSES, HOTEL_DEAL_CHANNELS,
  type HotelDealApprovalQueueItem, type HotelDealApprovalView, type HotelDealAuditTrail, type HotelDealCapabilities, type HotelDealDecisionInput, type HotelDealDetail, type HotelDealIssue,
  type HotelDealPage, type HotelDealPerformance, type HotelDealPlanRef, type HotelDealPreviewInput, type HotelDealPreviewResult, type HotelDealReconcileResult, type HotelDealStatus, type HotelDealSubmitInput,
  type HotelDealSummary, type HotelDealTerms, type HotelDealTransitionInput, type HotelDealView,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enabledSettlementCurrencies } from '../agent/currency'
import { idParam, likeLiteral, pageParams, textParam } from '../admin-operations/query-params'
import { hotelToday } from '../supply/rate-plan-expiry'
import { zonedLocalToUtc } from '../supply/zoned-time'
import { assessPlanSelect } from '../supply/assess-plan-select'
import { withDerivedRates } from '../supply/derived-rates'
import { buildStaySnapshot } from '../supply/stay-snapshot'
import { evaluateContractedStay, stayDates } from '../supply/contracted-sellability'
import { loadActiveMarkupRulesInTx } from '../supply/markup-rules.loader'
import { loadDealRulesInTx } from '../supply/deal-rules.loader'
import { CommercialControlUnavailableError } from '../supply/commercial-controls'
import { markupResolverFor } from '../supply/markup-rules'
import { normalizeCountry } from '../supply/market-rules'
import type { AssessPlan } from '../supply/commercial-assessment'
import {
  DEAL_TRANSITIONS, canTransition, dealFingerprint, dealToRule, effectiveDealStatus, isDay, maskToWeekdays, parseDealInput, rowToTerms, termsToColumns,
  type DealIssue, type DealStatus, type DealTermsRow,
} from '../supply/deal-model'

/** The approval action a deal activation is bound to (catalogued, S3, approval only, ADR 0089). The contracts package carries the same literal for the Admin. */
export const DEAL_APPROVAL_ACTION: typeof HOTEL_DEAL_APPROVAL_ACTION = 'promotion.activate'
const ENTITY_TYPE = 'hotel_deal'
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,80}$/
const REASON_MIN = 3
const REASON_MAX = 500
const LIST_CAP = 2000
const RECONCILE_BATCH = 200
/** How far ahead the commercial checks look at stored rates. */
const RATE_LOOKAHEAD_DAYS = 90

type Deal = Prisma.HotelDealGetPayload<{ include: { hotel: { select: { name: true; timeZone: true } }; ratePlans: { select: { ratePlanId: true } } } }>
const DEAL_INCLUDE = { hotel: { select: { name: true, timeZone: true } }, ratePlans: { select: { ratePlanId: true } } } as const

const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const addDays = (day: string, count: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)

function bad(issues: readonly DealIssue[], message = 'The promotion is not valid.'): BadRequestException {
  const first = issues.find((issue) => issue.severity === 'ERROR') ?? issues[0]
  return new BadRequestException({ code: first?.code ?? 'DEAL_INVALID', message: first?.message ?? message, details: issues })
}

function cleanReason(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException({ code: 'DEAL_REASON_REQUIRED', message: `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.` })
    return null
  }
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw new BadRequestException({ code: 'DEAL_REASON_REQUIRED', message: `A reason of ${REASON_MIN} to ${REASON_MAX} characters is required.` })
  return text
}

function expectedVersion(value: unknown, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException({ code: 'DEAL_VERSION_REQUIRED', message: 'expectedVersion is required.' })
    return null
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new BadRequestException({ code: 'DEAL_VERSION_REQUIRED', message: 'expectedVersion must be a positive whole number.' })
  return value
}

const percentText = (bp: number): string => `${Math.floor(bp / 100)}${bp % 100 === 0 ? '' : `.${String(bp % 100).padStart(2, '0')}`}%`
const majorText = (minor: bigint, currency: string): string => {
  const whole = minor / 100n
  const cents = minor % 100n
  return `${currency} ${whole}${cents === 0n ? '' : `.${cents.toString().padStart(2, '0')}`}`
}

/** One line a reviewer reads in the queue. Display only. */
export function dealSummary(terms: DealTermsRow): string {
  switch (terms.kind) {
    case 'PERCENT_OFF': return `${percentText(terms.percentBp ?? 0)} off every eligible night`
    case 'EARLY_BIRD': return `${percentText(terms.percentBp ?? 0)} off when booked ${terms.minLeadDays} or more days ahead`
    case 'FLASH_SALE': return `${percentText(terms.percentBp ?? 0)} off, booking window ${terms.bookFrom} to ${terms.bookTo}`
    case 'STAY_X_PAY_Y': return `Stay ${terms.minNights}, pay ${(terms.minNights ?? 0) - (terms.freeNights ?? 0)}`
    case 'SUBSEQUENT_NIGHTS': return `${percentText(terms.percentBp ?? 0)} off from night ${terms.fromNight}`
    case 'EVERY_NTH_FREE': return `Every ${terms.minNights}th night free`
    case 'FIXED_OFF': return `${majorText(terms.amountMinor ?? 0n, terms.currency ?? '')} off ${terms.amountScope === 'PER_STAY' ? 'per stay' : 'per night'}`
  }
}

const termsView = (terms: DealTermsRow): HotelDealTerms => ({
  ...terms, amountMinor: terms.amountMinor === null ? null : terms.amountMinor.toString(), minSellFloorMinor: terms.minSellFloorMinor === null ? null : terms.minSellFloorMinor.toString(),
  weekdays: maskToWeekdays(terms.weekdays), channels: terms.channels as HotelDealTerms['channels'],
})

/**
 * Hotel deals and promotions (ADR 0089). Every method takes the tenant from the authenticated session; every query names it, and PostgreSQL forces it again.
 * Lifecycle rules live in `supply/deal-model.ts` and are enforced once more by the database trigger, so a state or a changed term the model would refuse can
 * not be stored by any other path. Prices are never computed here: the preview runs the one stay evaluator, so a deal can not be priced differently from search.
 */
@Injectable()
export class HotelDealService {
  /** Replaceable in tests. */
  now: () => Date = () => new Date()

  constructor(private readonly prisma: PrismaService, private readonly approvals: ApprovalService) {}

  // ---- reads ------------------------------------------------------------------------------------------------------------------------

  private today(deal: { hotel: { timeZone: string } }): string | null { return hotelToday(this.now(), deal.hotel.timeZone) }

  private view(deal: Deal): HotelDealView {
    const status = deal.status as HotelDealStatus
    return {
      id: deal.id, hotelId: deal.hotelId, hotelName: deal.hotel.name, code: deal.code, name: deal.name, kind: deal.kind, status,
      effectiveStatus: effectiveDealStatus({ status, activeFrom: dayOf(deal.activeFrom), activeTo: dayOf(deal.activeTo) }, this.today(deal)) as HotelDealStatus,
      version: deal.version, percentBp: deal.percentBp, amountMinor: deal.amountMinor === null ? null : deal.amountMinor.toString(), currency: deal.currency,
      activeFrom: dayOf(deal.activeFrom), activeTo: dayOf(deal.activeTo), planCount: deal.ratePlans.length, statusReason: deal.statusReason,
      createdById: deal.createdById, createdAt: deal.createdAt.toISOString(), updatedAt: deal.updatedAt.toISOString(), activatedAt: deal.activatedAt?.toISOString() ?? null,
    }
  }

  private approvalView(approval: ApprovalView | undefined, me: string): HotelDealApprovalView | null {
    if (!approval) return null
    return {
      id: approval.id, status: approval.status, requestedById: approval.requestedById, decidedById: approval.decidedById, decisionReason: approval.decisionReason, reason: approval.reason,
      canDecide: approval.requestedById !== me && approval.status === 'PENDING', canCancel: approval.requestedById === me && approval.status === 'PENDING', canExecute: approval.status === 'APPROVED',
    }
  }

  private capabilities(deal: Deal, approval: ApprovalView | undefined, me: string): HotelDealCapabilities {
    const status = deal.status as DealStatus
    const pending = status === 'PENDING_APPROVAL' && approval?.status === 'PENDING'
    return {
      canEdit: status === 'DRAFT', canValidate: status !== 'ARCHIVED', canPreview: status !== 'ARCHIVED', canSubmit: status === 'DRAFT',
      canWithdraw: pending && approval?.requestedById === me, canApprove: pending && approval?.requestedById !== me, canReject: pending && approval?.requestedById !== me,
      canActivate: (status === 'PENDING_APPROVAL' || status === 'APPROVED') && approval?.status === 'APPROVED',
      canPause: status === 'ACTIVE' || status === 'SCHEDULED', canResume: status === 'PAUSED', canSuspend: status === 'ACTIVE' || status === 'SCHEDULED' || status === 'PAUSED',
      canReturnToDraft: status === 'REJECTED' || status === 'SUSPENDED' || status === 'APPROVED', canArchive: canTransition(status, 'ARCHIVED'),
    }
  }

  private async load(tx: Prisma.TransactionClient, tenantId: string, dealId: string): Promise<Deal> {
    const id = idParam('dealId', dealId)
    if (!id) throw new BadRequestException({ code: 'DEAL_ID_INVALID', message: 'Invalid dealId' })
    const deal = await tx.hotelDeal.findFirst({ where: { id, tenantId }, include: DEAL_INCLUDE })
    // Another tenant's deal is indistinguishable from none: row-level security hides it and the answer is the same 404.
    if (!deal) throw new NotFoundException({ code: 'DEAL_NOT_FOUND', message: 'Promotion not found' })
    return deal
  }

  private async lock(tx: Prisma.TransactionClient, tenantId: string, dealId: string): Promise<Deal> {
    const id = idParam('dealId', dealId)
    if (!id) throw new BadRequestException({ code: 'DEAL_ID_INVALID', message: 'Invalid dealId' })
    await tx.$queryRaw`SELECT id FROM "HotelDeal" WHERE id = ${id} AND tenant_id = ${tenantId} FOR UPDATE`
    return this.load(tx, tenantId, id)
  }

  private termsOf(deal: Deal): DealTermsRow { return rowToTerms(deal, deal.ratePlans.map((plan) => plan.ratePlanId)) }

  private async latestApproval(tenantId: string, deal: Deal): Promise<ApprovalView | undefined> {
    const all = await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [deal.id])
    const bound = deal.approvalId ? all.find((a) => a.id === deal.approvalId) : undefined
    // A deal that is not bound to a request shows the latest SETTLED one as history; an open request that no longer belongs to it is never offered for a decision.
    return bound ?? all.find((a) => a.status !== 'PENDING' && a.status !== 'APPROVED')
  }

  async list(tenantId: string, query: Record<string, unknown>): Promise<HotelDealPage> {
    const page = pageParams(query)
    const hotelId = idParam('hotelId', query.hotelId)
    const kind = typeof query.kind === 'string' && query.kind ? query.kind : undefined
    if (kind !== undefined && !['PERCENT_OFF', 'EARLY_BIRD', 'FLASH_SALE', 'STAY_X_PAY_Y', 'SUBSEQUENT_NIGHTS', 'EVERY_NTH_FREE', 'FIXED_OFF'].includes(kind)) throw new BadRequestException('Invalid kind')
    const status = typeof query.status === 'string' && query.status ? query.status : undefined
    if (status !== undefined && !(HOTEL_DEAL_STATUSES as readonly string[]).includes(status)) throw new BadRequestException('Invalid status')
    const search = textParam('q', query.q, 80)
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.hotelDeal.findMany({
      where: { tenantId, ...(hotelId ? { hotelId } : {}), ...(kind ? { kind: kind as Deal['kind'] } : {}), ...(search ? { OR: [{ code: { contains: likeLiteral(search), mode: 'insensitive' } }, { name: { contains: likeLiteral(search), mode: 'insensitive' } }] } : {}) },
      include: DEAL_INCLUDE, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: LIST_CAP,
    }))
    // The filter and the badge both use what applies today, so a tile count and the list behind it always agree.
    const views = rows.map((row) => this.view(row)).filter((item) => !status || item.effectiveStatus === status)
    return { items: views.slice(page.skip, page.skip + page.take), page: page.page, pageSize: page.pageSize, total: views.length }
  }

  async summary(tenantId: string, query: Record<string, unknown>): Promise<HotelDealSummary> {
    const hotelId = idParam('hotelId', query.hotelId)
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.hotelDeal.findMany({
      where: { tenantId, ...(hotelId ? { hotelId } : {}) }, select: { status: true, activeFrom: true, activeTo: true, hotel: { select: { timeZone: true } } }, take: LIST_CAP + 1,
    }))
    const byStatus = Object.fromEntries(HOTEL_DEAL_STATUSES.map((status) => [status, 0])) as Record<HotelDealStatus, number>
    for (const row of rows.slice(0, LIST_CAP)) byStatus[effectiveDealStatus({ status: row.status as DealStatus, activeFrom: dayOf(row.activeFrom), activeTo: dayOf(row.activeTo) }, hotelToday(this.now(), row.hotel.timeZone)) as HotelDealStatus] += 1
    return { total: Math.min(rows.length, LIST_CAP), byStatus, truncated: rows.length > LIST_CAP }
  }

  async get(tenantId: string, userId: string, dealId: string): Promise<HotelDealDetail> {
    const deal = await this.prisma.withTenant(tenantId, async (tx) => {
      const found = await this.load(tx, tenantId, dealId)
      const plans = await this.planRefs(tx, tenantId, found.ratePlans.map((plan) => plan.ratePlanId))
      const validation = found.status === 'ARCHIVED' ? [] : await this.validation(tx, tenantId, found, this.termsOf(found))
      return { found, plans, validation }
    })
    const approval = await this.latestApproval(tenantId, deal.found)
    return {
      ...this.view(deal.found), terms: termsView(this.termsOf(deal.found)), ratePlans: deal.plans, termsFingerprint: deal.found.termsFingerprint,
      approval: this.approvalView(approval, userId), validation: deal.validation.map((issue) => ({ ...issue })), capabilities: this.capabilities(deal.found, approval, userId),
    }
  }

  private async planRefs(tx: Prisma.TransactionClient, tenantId: string, ids: readonly string[]): Promise<HotelDealPlanRef[]> {
    if (ids.length === 0) return []
    const plans = await tx.ratePlan.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, code: true, status: true, currency: true, roomTypeId: true, roomType: { select: { name: true } }, contract: { select: { status: true } } }, orderBy: { code: 'asc' } })
    return plans.map((plan) => ({ id: plan.id, code: plan.code, status: plan.status, currency: plan.currency, roomTypeId: plan.roomTypeId, roomTypeName: plan.roomType.name, contractStatus: plan.contract.status }))
  }

  // ---- validation -------------------------------------------------------------------------------------------------------------------

  /**
   * Everything that must hold before a deal is submitted and again before it goes live, judged against the stored catalogue. ERRORs block; WARNINGs inform.
   * The deal itself is only ever read here. Nothing is priced by guess: a check that needs data it cannot read is an ERROR, not a pass.
   */
  private async validation(tx: Prisma.TransactionClient, tenantId: string, deal: Pick<Deal, 'id' | 'hotelId' | 'hotel'>, terms: DealTermsRow): Promise<DealIssue[]> {
    const issues: DealIssue[] = []
    const error = (code: string, message: string, field?: string) => issues.push({ code, message, severity: 'ERROR', ...(field ? { field } : {}) })
    const warn = (code: string, message: string, field?: string) => issues.push({ code, message, severity: 'WARNING', ...(field ? { field } : {}) })
    const today = hotelToday(this.now(), deal.hotel.timeZone)
    if (today === null) error('HOTEL_TIME_ZONE_INVALID', 'The hotel has no valid time zone, so the deal cannot be judged in its calendar and would never apply.')
    if (terms.activeTo !== null && today !== null && terms.activeTo < today) error('DEAL_WINDOW_ENDED', 'The deal window has already ended in the hotel calendar.', 'activeTo')

    const plans = await tx.ratePlan.findMany({
      where: { tenantId, id: { in: terms.ratePlanIds } },
      select: { id: true, code: true, status: true, currency: true, occupancy: true, derivedFromId: true, validFrom: true, validTo: true, roomType: { select: { hotelId: true } }, contract: { select: { status: true, validFrom: true, validTo: true } } },
    })
    if (plans.length !== terms.ratePlanIds.length) error('DEAL_PLAN_NOT_FOUND', 'A selected rate plan does not exist.', 'ratePlanIds')
    if (plans.some((plan) => plan.roomType.hotelId !== deal.hotelId)) error('DEAL_PLAN_OTHER_HOTEL', 'A selected rate plan belongs to another hotel.', 'ratePlanIds')
    const live = plans.filter((plan) => plan.status === 'ACTIVE')
    if (plans.length > 0 && live.length === 0) error('NO_ACTIVE_RATE_PLAN', 'None of the selected rate plans is ACTIVE, so the deal would not price anything.', 'ratePlanIds')
    for (const plan of plans) {
      if (plan.status !== 'ACTIVE' && live.length > 0) warn('PLAN_NOT_ACTIVE', `Rate plan ${plan.code} is ${plan.status}; the deal prices it only once it is ACTIVE.`, 'ratePlanIds')
      if (plan.contract.status !== 'ACTIVE') warn('CONTRACT_NOT_ACTIVE', `The contract of rate plan ${plan.code} is ${plan.contract.status}; it does not sell until the contract is ACTIVE.`, 'ratePlanIds')
    }
    if (terms.kind === 'FIXED_OFF') {
      const matching = plans.filter((plan) => plan.currency === terms.currency)
      if (plans.length > 0 && matching.length === 0) error('PLAN_CURRENCY_MISMATCH', `No selected rate plan is priced in ${terms.currency}, so a fixed amount in ${terms.currency} would never apply.`, 'currency')
      else for (const plan of plans) if (plan.currency !== terms.currency) warn('PLAN_CURRENCY_MISMATCH', `Rate plan ${plan.code} is priced in ${plan.currency}; the fixed amount in ${terms.currency} never applies to it.`, 'currency')
    }
    if (terms.channels.includes('API')) warn('CHANNEL_API_NOT_DISTRIBUTED', 'No distribution API search exists yet, so a deal limited to the API channel is not applied anywhere until it does.', 'channels')
    const stayStart = terms.stayFrom ?? terms.activeFrom
    const stayEnd = terms.stayTo ?? terms.activeTo
    for (const plan of plans) {
      const validFrom = [dayOf(plan.validFrom), dayOf(plan.contract.validFrom)].filter((value): value is string => value !== null).sort().pop() ?? null
      const validTo = [dayOf(plan.validTo), dayOf(plan.contract.validTo)].filter((value): value is string => value !== null).sort()[0] ?? null
      if ((stayEnd !== null && validFrom !== null && stayEnd < validFrom) || (stayStart !== null && validTo !== null && stayStart > validTo)) warn('OUTSIDE_PLAN_VALIDITY', `The deal's dates fall outside the validity of rate plan ${plan.code}; the evaluator will not sell those nights.`, 'stayFrom')
    }

    if (terms.agencyIds.length > 0) {
      const found = await tx.agency.count({ where: { tenantId, id: { in: terms.agencyIds } } })
      if (found !== terms.agencyIds.length) error('AGENCY_NOT_FOUND', 'A listed agency does not exist in this tenant.', 'agencyIds')
    }
    if (terms.incompatibleDealIds.length > 0) {
      const found = await tx.hotelDeal.count({ where: { tenantId, hotelId: deal.hotelId, id: { in: terms.incompatibleDealIds } } })
      if (found !== terms.incompatibleDealIds.length) error('INCOMPATIBLE_DEAL_NOT_FOUND', 'A listed incompatible deal does not exist for this hotel.', 'incompatibleDealIds')
      if (terms.incompatibleDealIds.includes(deal.id)) error('INCOMPATIBLE_WITH_ITSELF', 'A deal cannot be incompatible with itself.', 'incompatibleDealIds')
    }

    // Stored rates over the next stretch: what the guards can and cannot protect.
    if (today !== null && live.length > 0) {
      const rates = await tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: live.map((plan) => plan.id) }, stayDate: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${addDays(today, RATE_LOOKAHEAD_DAYS)}T00:00:00Z`) } }, select: { ratePlanId: true, amountMinor: true, amountBasis: true, occupancy: true } })
      for (const plan of live) {
        const own = rates.filter((rate) => rate.ratePlanId === plan.id && rate.occupancy === plan.occupancy)
        if (own.length === 0 && plan.derivedFromId === null) warn('NO_RATES_AHEAD', `Rate plan ${plan.code} has no stored rate in the next ${RATE_LOOKAHEAD_DAYS} days.`, 'ratePlanIds')
        const smallest = own.reduce<bigint | null>((min, rate) => (min === null || rate.amountMinor < min ? rate.amountMinor : min), null)
        if (terms.kind === 'FIXED_OFF' && terms.amountScope === 'PER_NIGHT' && terms.amountMinor !== null && smallest !== null && terms.amountMinor >= smallest && plan.currency === terms.currency) warn('DISCOUNT_EXCEEDS_RATE', `The per-night amount is not below the lowest stored rate of ${plan.code}; those nights are discounted down to one minor unit at most.`, 'amountMinor')
        if (terms.minMarginBp !== null && own.some((rate) => rate.amountBasis === 'SELL')) warn('MARGIN_GUARD_UNVERIFIABLE', `Rate plan ${plan.code} has SELL-basis rates: no supplier net is known there, so the margin guard cannot be verified and the deal does not apply on those nights.`, 'minMarginBp')
        if (terms.minSellFloorMinor !== null && own.some((rate) => rate.amountBasis === 'SELL' && terms.minSellFloorMinor !== null && rate.amountMinor < terms.minSellFloorMinor)) warn('FLOOR_ABOVE_BASE_SELL', `Some SELL-basis nights of ${plan.code} already sell below the minimum sell floor; the deal does not apply there.`, 'minSellFloorMinor')
      }
    }

    // Overlap with other live or pending deals on the same plans.
    const others = await tx.hotelDealRatePlan.findMany({
      where: { tenantId, ratePlanId: { in: terms.ratePlanIds }, deal: { tenantId, id: { not: deal.id }, status: { in: ['ACTIVE', 'SCHEDULED', 'PENDING_APPROVAL', 'APPROVED'] } } },
      select: { ratePlanId: true, deal: { select: { id: true, code: true, activeFrom: true, activeTo: true, combinable: true } } },
    })
    const overlapping = new Map<string, { code: string; plans: number; combinable: boolean }>()
    for (const link of others) {
      const from = dayOf(link.deal.activeFrom); const to = dayOf(link.deal.activeTo)
      if ((terms.activeTo !== null && from !== null && from > terms.activeTo) || (terms.activeFrom !== null && to !== null && to < terms.activeFrom)) continue
      const entry = overlapping.get(link.deal.id) ?? { code: link.deal.code, plans: 0, combinable: link.deal.combinable }
      entry.plans += 1
      overlapping.set(link.deal.id, entry)
    }
    for (const entry of overlapping.values()) warn('OVERLAPS_DEAL', `Deal ${entry.code} overlaps on ${entry.plans} rate plan(s). One promotion prices a stay (the larger saving, then the higher priority) unless both are combinable and not excluded.`, 'activeFrom')
    return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'ERROR' ? -1 : 1))
  }

  async validate(tenantId: string, dealId: string): Promise<{ dealId: string; valid: boolean; issues: HotelDealIssue[] }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const deal = await this.load(tx, tenantId, dealId)
      const issues = await this.validation(tx, tenantId, deal, this.termsOf(deal))
      return { dealId: deal.id, valid: !issues.some((issue) => issue.severity === 'ERROR'), issues }
    })
  }

  // ---- authoring --------------------------------------------------------------------------------------------------------------------

  private async scopeChecks(tx: Prisma.TransactionClient, tenantId: string, hotelId: string, terms: DealTermsRow): Promise<void> {
    const plans = await tx.ratePlan.count({ where: { tenantId, id: { in: terms.ratePlanIds }, roomType: { hotelId } } })
    if (plans !== terms.ratePlanIds.length) throw new BadRequestException({ code: 'DEAL_PLAN_NOT_IN_HOTEL', message: 'Every selected rate plan must belong to this hotel.', details: [{ code: 'DEAL_PLAN_NOT_IN_HOTEL', field: 'ratePlanIds', message: 'Every selected rate plan must belong to this hotel.', severity: 'ERROR' }] })
    if (terms.agencyIds.length > 0 && (await tx.agency.count({ where: { tenantId, id: { in: terms.agencyIds } } })) !== terms.agencyIds.length) throw bad([{ code: 'AGENCY_NOT_FOUND', field: 'agencyIds', message: 'A listed agency does not exist in this tenant.', severity: 'ERROR' }])
    if (terms.incompatibleDealIds.length > 0 && (await tx.hotelDeal.count({ where: { tenantId, hotelId, id: { in: terms.incompatibleDealIds } } })) !== terms.incompatibleDealIds.length) throw bad([{ code: 'INCOMPATIBLE_DEAL_NOT_FOUND', field: 'incompatibleDealIds', message: 'A listed incompatible deal does not exist for this hotel.', severity: 'ERROR' }])
  }

  private audit(tx: Prisma.TransactionClient, tenantId: string, userId: string, action: string, dealId: string, payload: Record<string, unknown>, requestId?: string) {
    return tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action, entityType: ENTITY_TYPE, entityId: dealId, payload: sanitizeAuditPayload({ ...payload, requestId: requestId ?? null }) } })
  }

  /** The fields that changed between two term sets, without free text (notes and descriptions are not copied into the audit trail). */
  private diff(before: DealTermsRow, after: DealTermsRow): Array<{ field: string; from: unknown; to: unknown }> {
    const skip = new Set(['internalNotes', 'publicDescription'])
    const out: Array<{ field: string; from: unknown; to: unknown }> = []
    const plain = (value: unknown) => (typeof value === 'bigint' ? value.toString() : Array.isArray(value) ? [...value].sort() : value)
    for (const key of Object.keys(after) as Array<keyof DealTermsRow>) {
      if (skip.has(key)) continue
      const from = plain(before[key]); const to = plain(after[key])
      if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field: key, from, to })
    }
    if (before.internalNotes !== after.internalNotes || before.publicDescription !== after.publicDescription) out.push({ field: 'descriptions', from: 'changed', to: 'changed' })
    return out
  }

  async create(tenantId: string, userId: string, body: unknown, requestId?: string): Promise<HotelDealDetail> {
    const parsed = parseDealInput(body, enabledSettlementCurrencies())
    const raw = (body ?? {}) as Record<string, unknown>
    const issues = [...parsed.issues]
    const idempotencyKey = typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : ''
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) issues.push({ code: 'DEAL_IDEMPOTENCY_KEY_REQUIRED', field: 'idempotencyKey', message: 'idempotencyKey is required: 8 to 80 letters, digits or . _ : -', severity: 'ERROR' })
    const hotelId = typeof raw.hotelId === 'string' ? idParam('hotelId', raw.hotelId) : undefined
    if (!hotelId) issues.push({ code: 'DEAL_HOTEL_REQUIRED', field: 'hotelId', message: 'hotelId is required.', severity: 'ERROR' })
    if (!parsed.terms || issues.some((issue) => issue.severity === 'ERROR')) throw bad(issues)
    const terms = parsed.terms
    const attempt = () => this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await tx.hotel.findFirst({ where: { id: hotelId!, tenantId }, select: { id: true } })
      if (!hotel) throw new NotFoundException({ code: 'HOTEL_NOT_FOUND', message: 'Hotel not found' })
      const existing = await tx.hotelDeal.findFirst({ where: { tenantId, idempotencyKey }, include: DEAL_INCLUDE })
      if (existing) {
        // A retry of the same request returns the same deal; the same key for anything else is a client error, never a second deal.
        if (existing.createdById === userId && existing.hotelId === hotel.id && dealFingerprint(hotel.id, this.termsOf(existing)) === dealFingerprint(hotel.id, terms)) return { deal: existing, replayed: true }
        throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This idempotencyKey was already used for a different promotion.' })
      }
      await this.scopeChecks(tx, tenantId, hotel.id, terms)
      const row = await tx.hotelDeal.create({ data: { tenantId, hotelId: hotel.id, ...termsToColumns(terms), idempotencyKey, createdById: userId } })
      await tx.hotelDealRatePlan.createMany({ data: terms.ratePlanIds.map((ratePlanId) => ({ tenantId, dealId: row.id, ratePlanId })) })
      await this.audit(tx, tenantId, userId, 'promotion.deal.created', row.id, { dealId: row.id, hotelId: hotel.id, code: terms.code, kind: terms.kind, version: row.version, planCount: terms.ratePlanIds.length }, requestId)
      return { deal: await this.load(tx, tenantId, row.id), replayed: false }
    })
    const clash = (error: unknown) => (error as { code?: string }).code === 'P2002'
    let created: Awaited<ReturnType<typeof attempt>>
    try { created = await attempt() } catch (error) {
      if (!clash(error)) throw error
      // Postgres names whichever unique index it checks first, so the loser of a race on one idempotency key may be told "code". It asks once more: the winner's deal is now visible and is replayed; a genuine code clash fails the same way again.
      try { created = await attempt() } catch (again) {
        if (!clash(again)) throw again
        throw new ConflictException({ code: 'DEAL_CODE_TAKEN', message: `The promotion code ${terms.code} is already used in this tenant.` })
      }
    }
    return this.get(tenantId, userId, created.deal.id)
  }

  async replace(tenantId: string, userId: string, dealId: string, body: unknown, requestId?: string): Promise<HotelDealDetail> {
    const parsed = parseDealInput(body, enabledSettlementCurrencies())
    const raw = (body ?? {}) as Record<string, unknown>
    const version = expectedVersion(raw.expectedVersion, true)!
    if (!parsed.terms) throw bad(parsed.issues)
    const terms = parsed.terms
    await this.prisma.withTenant(tenantId, async (tx) => {
      const deal = await this.lock(tx, tenantId, dealId)
      if (raw.hotelId !== undefined && raw.hotelId !== deal.hotelId) throw new BadRequestException({ code: 'DEAL_FIELD_NOT_ALLOWED', message: 'The hotel of a promotion cannot be changed.' })
      if (deal.status !== 'DRAFT') throw new ConflictException({ code: 'DEAL_TERMS_LOCKED', message: `A ${deal.status} promotion cannot be edited. Return it to draft to make a new version.` })
      if (deal.version !== version) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed since it was loaded. Reload and review before retrying.' })
      await this.scopeChecks(tx, tenantId, deal.hotelId, terms)
      const changes = this.diff(this.termsOf(deal), terms)
      try {
        const moved = await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: 'DRAFT', version }, data: { ...termsToColumns(terms), version: version + 1 } })
        if (moved.count !== 1) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed since it was loaded. Reload and review before retrying.' })
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'DEAL_CODE_TAKEN', message: `The promotion code ${terms.code} is already used in this tenant.` })
        throw error
      }
      await tx.hotelDealRatePlan.deleteMany({ where: { tenantId, dealId: deal.id } })
      await tx.hotelDealRatePlan.createMany({ data: terms.ratePlanIds.map((ratePlanId) => ({ tenantId, dealId: deal.id, ratePlanId })) })
      await this.audit(tx, tenantId, userId, 'promotion.deal.updated', deal.id, { dealId: deal.id, fromVersion: version, toVersion: version + 1, changes }, requestId)
    })
    return this.get(tenantId, userId, dealId)
  }

  // ---- approval ---------------------------------------------------------------------------------------------------------------------

  async submit(tenantId: string, userId: string, dealId: string, body: HotelDealSubmitInput, requestId?: string): Promise<HotelDealDetail> {
    const raw = (body ?? {}) as unknown as Record<string, unknown>
    const version = expectedVersion(raw.expectedVersion, true)!
    const approvalRequestId = typeof raw.requestId === 'string' && /^[A-Za-z0-9_.:-]{8,80}$/.test(raw.requestId) ? raw.requestId : null
    if (!approvalRequestId) throw new BadRequestException({ code: 'DEAL_REQUEST_ID_REQUIRED', message: 'requestId is required: 8 to 80 letters, digits or . _ : -' })
    const reason = cleanReason(raw.reason, true)!
    const prepared = await this.prisma.withTenant(tenantId, async (tx) => {
      const deal = await this.load(tx, tenantId, dealId)
      if (deal.status !== 'DRAFT') throw new ConflictException({ code: 'DEAL_TRANSITION_NOT_ALLOWED', message: `A ${deal.status} promotion cannot be submitted.` })
      if (deal.version !== version) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed since it was loaded. Reload and review before retrying.' })
      const terms = this.termsOf(deal)
      const issues = await this.validation(tx, tenantId, deal, terms)
      if (issues.some((issue) => issue.severity === 'ERROR')) throw new ConflictException({ code: 'DEAL_VALIDATION_FAILED', message: 'The promotion has blocking validation errors and cannot be submitted.', details: issues })
      return { deal, terms, fingerprint: dealFingerprint(deal.hotelId, terms) }
    })
    // The approval is bound to exactly these terms. Requesting is idempotent on requestId, so a retry after a failure below finds the same request.
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: DEAL_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: dealId, requestId: approvalRequestId, reason,
      beforeState: { status: 'DRAFT', version },
      proposedState: { dealId, version, termsFingerprint: prepared.fingerprint, kind: prepared.terms.kind, hotelId: prepared.deal.hotelId, planCount: prepared.terms.ratePlanIds.length, summary: dealSummary(prepared.terms) },
    })
    try {
      await this.prisma.withTenant(tenantId, async (tx) => {
        const deal = await this.lock(tx, tenantId, dealId)
        if (deal.status === 'PENDING_APPROVAL' && deal.approvalId === approval.id) return
        const moved = await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: 'DRAFT', version }, data: { status: 'PENDING_APPROVAL', termsFingerprint: prepared.fingerprint, approvalId: approval.id, statusChangedAt: this.now(), statusChangedById: userId, statusReason: null } })
        if (moved.count !== 1) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed while it was submitted. Reload and review before retrying.' })
        await this.audit(tx, tenantId, userId, 'promotion.deal.submitted', deal.id, { dealId: deal.id, version, termsFingerprint: prepared.fingerprint, approvalId: approval.id }, requestId)
      })
    } catch (error) {
      // The request was filed for terms that are no longer the deal's. Leaving it pending would invite a decision on something that can never be activated.
      await this.approvals.cancel({ tenantId, requesterId: userId, approvalId: approval.id }).catch(() => undefined)
      throw error
    }
    return this.get(tenantId, userId, dealId)
  }

  private async approvalFor(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const approval = await this.approvals.get(tenantId, approvalId)
    if (approval.entityType !== ENTITY_TYPE || approval.action !== DEAL_APPROVAL_ACTION) throw new BadRequestException({ code: 'NOT_A_PROMOTION_APPROVAL', message: 'Not a promotion approval' })
    return approval
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: HotelDealDecisionInput, requestId?: string): Promise<HotelDealDetail> {
    const reason = cleanReason((body as unknown as Record<string, unknown> | undefined)?.reason, true)!
    const approval = await this.approvalFor(tenantId, approvalId)
    // The approval service refuses the maker deciding their own request (403) and any second decision (409).
    await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason })
    await this.prisma.withTenant(tenantId, async (tx) => {
      const deal = await this.lock(tx, tenantId, approval.entityId)
      if (deal.status !== 'PENDING_APPROVAL' || deal.approvalId !== approvalId) return
      const target: DealStatus = decision === 'APPROVED' ? 'APPROVED' : 'REJECTED'
      const moved = await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: 'PENDING_APPROVAL', approvalId }, data: { status: target, statusChangedAt: this.now(), statusChangedById: userId, statusReason: target === 'REJECTED' ? reason : null } })
      if (moved.count === 1) await this.audit(tx, tenantId, userId, decision === 'APPROVED' ? 'promotion.deal.approved' : 'promotion.deal.rejected', deal.id, { dealId: deal.id, version: deal.version, approvalId, reason }, requestId)
    })
    return this.get(tenantId, userId, approval.entityId)
  }

  /**
   * Activates the approved deal once. It must still be exactly what was approved (version and fingerprint), still valid, and its window must not have ended.
   * The approval is single-use and is released if anything here fails, so a refused activation can be retried after the cause is fixed.
   */
  async execute(tenantId: string, userId: string, approvalId: string, requestId?: string): Promise<HotelDealDetail> {
    const approval = await this.approvalFor(tenantId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: DEAL_APPROVAL_ACTION }, async (executed) => {
      const proposed = (executed.proposedState ?? {}) as { dealId?: string; version?: number; termsFingerprint?: string }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const deal = await this.lock(tx, tenantId, executed.entityId)
        if (proposed.dealId !== deal.id || (deal.status !== 'APPROVED' && deal.status !== 'PENDING_APPROVAL') || deal.approvalId !== approvalId) throw new ConflictException({ code: 'DEAL_NOT_AWAITING_ACTIVATION', message: 'The promotion is not waiting for this approval.' })
        const terms = this.termsOf(deal)
        const fingerprint = dealFingerprint(deal.hotelId, terms)
        if (deal.version !== proposed.version || fingerprint !== proposed.termsFingerprint || fingerprint !== deal.termsFingerprint) throw new ConflictException({ code: 'DEAL_DIFFERS_FROM_APPROVAL', message: 'The promotion differs from what was approved.' })
        const issues = await this.validation(tx, tenantId, deal, terms)
        if (issues.some((issue) => issue.severity === 'ERROR')) throw new ConflictException({ code: 'DEAL_VALIDATION_FAILED', message: 'The promotion no longer passes validation and was not activated.', details: issues })
        const today = this.today(deal)
        if (today === null) throw new ConflictException({ code: 'HOTEL_TIME_ZONE_INVALID', message: 'The hotel has no valid time zone.' })
        const start = terms.activeFrom
        const target: DealStatus = start !== null && start > today ? 'SCHEDULED' : 'ACTIVE'
        const now = this.now()
        if (deal.status === 'PENDING_APPROVAL') await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: 'PENDING_APPROVAL', approvalId }, data: { status: 'APPROVED', statusChangedAt: now, statusChangedById: executed.decidedById ?? userId } })
        const moved = await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: 'APPROVED', approvalId, version: deal.version }, data: { status: target, activatedAt: now, activatedById: userId, statusChangedAt: now, statusChangedById: userId, statusReason: null } })
        if (moved.count !== 1) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed during activation.' })
        await this.audit(tx, tenantId, userId, 'promotion.deal.activated', deal.id, { dealId: deal.id, version: deal.version, status: target, approvalId, requestedById: executed.requestedById, decidedById: executed.decidedById, termsFingerprint: fingerprint }, requestId)
        return deal.id
      })
    })
    return this.get(tenantId, userId, out.result ?? approval.entityId)
  }

  async approvalQueue(tenantId: string, userId: string): Promise<HotelDealApprovalQueueItem[]> {
    const rows = await this.prisma.withTenant(tenantId, async (tx) => {
      const deals = await tx.hotelDeal.findMany({ where: { tenantId, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, include: DEAL_INCLUDE, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 200 })
      const checked: Array<{ deal: Deal; issues: DealIssue[] }> = []
      for (const deal of deals) checked.push({ deal, issues: await this.validation(tx, tenantId, deal, this.termsOf(deal)) })
      return checked
    })
    const approvals = await this.approvals.listForEntities(tenantId, ENTITY_TYPE, rows.map((row) => row.deal.id))
    const items: HotelDealApprovalQueueItem[] = []
    for (const row of rows) {
      const approval = approvals.find((a) => a.id === row.deal.approvalId) ?? approvals.find((a) => a.entityId === row.deal.id)
      const view = this.approvalView(approval, userId)
      if (view) items.push({ deal: this.view(row.deal), approval: view, validation: row.issues, ratePlanCount: row.deal.ratePlans.length, summary: dealSummary(this.termsOf(row.deal)) })
    }
    return items
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------------------------

  async withdraw(tenantId: string, userId: string, dealId: string, requestId?: string): Promise<HotelDealDetail> {
    const deal = await this.prisma.withTenant(tenantId, (tx) => this.load(tx, tenantId, dealId))
    if (deal.status !== 'PENDING_APPROVAL' || !deal.approvalId) throw new ConflictException({ code: 'DEAL_TRANSITION_NOT_ALLOWED', message: `A ${deal.status} promotion cannot be withdrawn.` })
    // Only the maker may withdraw (the approval service refuses anyone else). The request is cancelled first, then the deal returns to draft as a new version.
    await this.approvals.cancel({ tenantId, requesterId: userId, approvalId: deal.approvalId })
    await this.prisma.withTenant(tenantId, async (tx) => {
      const locked = await this.lock(tx, tenantId, dealId)
      if (locked.status !== 'PENDING_APPROVAL') return
      await this.toDraft(tx, tenantId, userId, locked, 'withdrawn', null, requestId)
    })
    return this.get(tenantId, userId, dealId)
  }

  private async toDraft(tx: Prisma.TransactionClient, tenantId: string, userId: string, deal: Deal, why: string, reason: string | null, requestId?: string): Promise<void> {
    const moved = await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: deal.status, version: deal.version }, data: { status: 'DRAFT', version: deal.version + 1, termsFingerprint: null, approvalId: null, activatedAt: null, activatedById: null, statusReason: null, statusChangedAt: this.now(), statusChangedById: userId } })
    if (moved.count !== 1) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed. Reload and retry.' })
    await this.audit(tx, tenantId, userId, 'promotion.deal.returned_to_draft', deal.id, { dealId: deal.id, from: deal.status, why, reason, fromVersion: deal.version, toVersion: deal.version + 1 }, requestId)
  }

  /** pause, resume, suspend, return-to-draft and archive. Each is one guarded, audited change; repeating the same request is harmless. */
  async transition(tenantId: string, userId: string, dealId: string, action: 'pause' | 'resume' | 'suspend' | 'return-to-draft' | 'archive', body: HotelDealTransitionInput | undefined, requestId?: string): Promise<HotelDealDetail> {
    const raw = (body ?? {}) as unknown as Record<string, unknown>
    const version = expectedVersion(raw.expectedVersion, false)
    const reason = cleanReason(raw.reason, action === 'pause' || action === 'suspend')
    await this.prisma.withTenant(tenantId, async (tx) => {
      const deal = await this.lock(tx, tenantId, dealId)
      const from = deal.status as DealStatus
      if (version !== null && deal.version !== version) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed since it was loaded. Reload and review before retrying.' })
      const today = this.today(deal)
      let target: DealStatus
      if (action === 'pause') target = 'PAUSED'
      else if (action === 'suspend') target = 'SUSPENDED'
      else if (action === 'archive') target = 'ARCHIVED'
      else if (action === 'return-to-draft') target = 'DRAFT'
      else {
        if (today === null) throw new ConflictException({ code: 'HOTEL_TIME_ZONE_INVALID', message: 'The hotel has no valid time zone.' })
        if (deal.activeTo !== null && dayOf(deal.activeTo)! < today) throw new ConflictException({ code: 'DEAL_WINDOW_ENDED', message: 'The deal window has ended; it cannot be resumed.' })
        target = deal.activeFrom !== null && dayOf(deal.activeFrom)! > today ? 'SCHEDULED' : 'ACTIVE'
      }
      if (from === target) return
      if (!canTransition(from, target)) throw new ConflictException({ code: 'DEAL_TRANSITION_NOT_ALLOWED', message: `A ${from} promotion cannot move to ${target}. Allowed: ${DEAL_TRANSITIONS[from].join(', ') || 'none'}.` })
      if (target === 'DRAFT') return this.toDraft(tx, tenantId, userId, deal, action, reason, requestId)
      if (action === 'resume') {
        // Resuming sells again, so it must pass the same checks activation did.
        const issues = await this.validation(tx, tenantId, deal, this.termsOf(deal))
        if (issues.some((issue) => issue.severity === 'ERROR')) throw new ConflictException({ code: 'DEAL_VALIDATION_FAILED', message: 'The promotion no longer passes validation and was not resumed.', details: issues })
      }
      const moved = await tx.hotelDeal.updateMany({ where: { id: deal.id, tenantId, status: from, version: deal.version }, data: { status: target, statusReason: target === 'PAUSED' || target === 'SUSPENDED' ? reason : null, statusChangedAt: this.now(), statusChangedById: userId } })
      if (moved.count !== 1) throw new ConflictException({ code: 'DEAL_CHANGED', message: 'The promotion changed. Reload and retry.' })
      await this.audit(tx, tenantId, userId, `promotion.deal.${action === 'resume' ? 'resumed' : action === 'pause' ? 'paused' : action === 'suspend' ? 'suspended' : 'archived'}`, deal.id, { dealId: deal.id, from, to: target, version: deal.version, reason }, requestId)
    })
    return this.get(tenantId, userId, dealId)
  }

  /**
   * Persists the labels the evaluator already applies: SCHEDULED to ACTIVE when the start day has come, and ACTIVE, SCHEDULED or PAUSED to EXPIRED when the end day
   * has passed (hotel calendar). Idempotent and safe to repeat; nothing about what sells depends on it having run (ADR 0089).
   */
  async reconcile(tenantId: string, userId: string, requestId?: string): Promise<HotelDealReconcileResult> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.hotelDeal.findMany({ where: { tenantId, status: { in: ['SCHEDULED', 'ACTIVE', 'PAUSED'] } }, select: { id: true, status: true, version: true, activeFrom: true, activeTo: true, hotel: { select: { timeZone: true } } }, orderBy: { id: 'asc' }, take: RECONCILE_BATCH })
      const result: HotelDealReconcileResult = { activated: 0, expired: 0, examined: rows.length, ids: { activated: [], expired: [] } }
      for (const row of rows) {
        const from = row.status as DealStatus
        const target = effectiveDealStatus({ status: from, activeFrom: dayOf(row.activeFrom), activeTo: dayOf(row.activeTo) }, hotelToday(this.now(), row.hotel.timeZone))
        if (target === from || (target !== 'ACTIVE' && target !== 'EXPIRED') || !canTransition(from, target)) continue
        const moved = await tx.hotelDeal.updateMany({ where: { id: row.id, tenantId, status: from, version: row.version }, data: { status: target, statusReason: null, statusChangedAt: this.now(), statusChangedById: userId } })
        if (moved.count !== 1) continue
        await this.audit(tx, tenantId, userId, target === 'EXPIRED' ? 'promotion.deal.expired' : 'promotion.deal.started', row.id, { dealId: row.id, from, to: target, via: 'reconcile' }, requestId)
        if (target === 'EXPIRED') { result.expired += 1; result.ids.expired.push(row.id) } else { result.activated += 1; result.ids.activated.push(row.id) }
      }
      return result
    })
  }

  // ---- simulation -------------------------------------------------------------------------------------------------------------------

  /**
   * Prices one stay with and without this deal through the shared evaluator. Reads only: no rate, stock, hold or booking is written, and the deal is not
   * changed. If the stay is not sellable without the deal the answer is the reasons, never a price. The audience (market, agency) and channel are the ones named
   * in the request, because there is no authenticated buyer here; leaving them out shows exactly what a deal restricted to them would do for an unknown buyer.
   */
  async preview(tenantId: string, dealId: string, body: HotelDealPreviewInput): Promise<HotelDealPreviewResult> {
    const raw = (body ?? {}) as unknown as Record<string, unknown>
    const issues: string[] = []
    const ratePlanId = typeof raw.ratePlanId === 'string' ? idParam('ratePlanId', raw.ratePlanId) : undefined
    if (!ratePlanId) issues.push('ratePlanId is required.')
    const checkIn = raw.checkIn
    if (!isDay(checkIn)) issues.push('checkIn must be a calendar day (YYYY-MM-DD).')
    const num = (value: unknown, min: number, max: number, fallback: number, name: string): number => {
      if (value === undefined || value === null) return fallback
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) { issues.push(`${name} must be a whole number from ${min} to ${max}.`); return fallback }
      return value
    }
    const nights = num(raw.nights, 1, 60, 1, 'nights'); const adults = num(raw.adults, 1, 20, 2, 'adults'); const children = num(raw.children, 0, 10, 0, 'children'); const rooms = num(raw.rooms, 1, 10, 1, 'rooms')
    const childAges = Array.isArray(raw.childAges) ? raw.childAges : undefined
    if (childAges !== undefined && (childAges.length !== children || childAges.some((age) => typeof age !== 'number' || !Number.isInteger(age) || age < 0 || age > 17))) issues.push('childAges needs one age from 0 to 17 per child.')
    if (raw.bookingDate !== undefined && !isDay(raw.bookingDate)) issues.push('bookingDate must be a calendar day (YYYY-MM-DD).')
    const channel = raw.channel === undefined || raw.channel === null ? null : raw.channel
    if (channel !== null && !(HOTEL_DEAL_CHANNELS as readonly unknown[]).includes(channel)) issues.push('channel must be PORTAL or API.')
    const market = raw.market === undefined || raw.market === null ? null : normalizeCountry(raw.market as string)
    if (raw.market !== undefined && raw.market !== null && market === null) issues.push('market must be a two-letter country code.')
    const nationality = raw.nationality === undefined || raw.nationality === null ? null : normalizeCountry(raw.nationality as string)
    if (raw.nationality !== undefined && raw.nationality !== null && nationality === null) issues.push('nationality must be a two-letter country code.')
    const agencyId = raw.agencyId === undefined || raw.agencyId === null ? null : idParam('agencyId', raw.agencyId) ?? null
    if (issues.length) throw new BadRequestException({ code: 'PREVIEW_INVALID', message: issues[0], details: issues.map((message) => ({ code: 'PREVIEW_INVALID', message, severity: 'ERROR' })) })

    return this.prisma.withTenant(tenantId, async (tx) => {
      const deal = await this.load(tx, tenantId, dealId)
      if (!deal.ratePlans.some((plan) => plan.ratePlanId === ratePlanId)) throw new BadRequestException({ code: 'PLAN_NOT_IN_DEAL', message: 'The rate plan is not part of this promotion.' })
      const checkInDay = checkIn as string
      const first = new Date(`${checkInDay}T00:00:00.000Z`)
      const last = new Date(first.getTime() + (nights - 1) * 86_400_000)
      const checkOut = new Date(first.getTime() + nights * 86_400_000).toISOString().slice(0, 10)
      const dates = stayDates(checkInDay, checkOut)
      const rawPlan = await tx.ratePlan.findFirst({ where: { id: ratePlanId!, tenantId }, select: assessPlanSelect(tenantId, { gte: first, lte: last }) })
      if (!rawPlan) throw new NotFoundException({ code: 'RATE_PLAN_NOT_FOUND', message: 'Rate plan not found' })
      const timeZone = rawPlan.roomType.hotel.timeZone
      let now = this.now()
      if (raw.bookingDate !== undefined) {
        try { now = zonedLocalToUtc(raw.bookingDate as string, '12:00', timeZone) } catch { throw new BadRequestException({ code: 'HOTEL_TIME_ZONE_INVALID', message: 'The hotel has no valid time zone.' }) }
      }
      const deals = await loadDealRulesInTx(tx, tenantId, [rawPlan.id], () => { throw new CommercialControlUnavailableError('hotel_deals', 'denied') })
      const others = (deals.get(rawPlan.id) ?? []).filter((rule) => rule.id !== deal.id)
      const base = { ...withDerivedRates(rawPlan) } as unknown as AssessPlan
      const mapping = base.contract.supplierHotelMappingId ? await tx.supplierHotelMapping.findFirst({ where: { id: base.contract.supplierHotelMappingId, tenantId }, select: { id: true, status: true, hotelId: true } }) : null
      const roomMapping = mapping ? await tx.supplierRoomMapping.findFirst({ where: { tenantId, supplierHotelMappingId: mapping.id, roomTypeId: base.roomTypeId }, select: { status: true } }) : null
      const markupRules = await loadActiveMarkupRulesInTx(tx, tenantId, () => { throw new CommercialControlUnavailableError('markup_rules', 'denied') })
      const resolver = markupResolverFor(markupRules, base.contract.supplierId, base.roomType.hotelId, { agencyId, market })
      const request = { checkIn: checkInDay, checkOut, rooms, adults, children, ...(childAges ? { childAges: childAges as number[] } : {}), currency: base.currency, now, buyer: { nationality, market, agencyId }, channel: channel as string | null, detail: true }
      const price = (rules: typeof others) => evaluateContractedStay(buildStaySnapshot({ ...base, dealRules: rules }, mapping, roomMapping, dates, resolver, { adults }), request)
      const without = price(others)
      const withDeal = price([...others, dealToRule(deal.id, this.termsOf(deal))])
      const minor = (value: bigint | null | undefined): string => (value === null || value === undefined ? '0' : value.toString())
      const roomsBig = BigInt(rooms)
      const eligible = without.eligible && withDeal.eligible
      const margin = (decision: typeof without): number | null => (decision.eligible && decision.totalMinor !== null && decision.totalMinor > 0n && decision.netMinor !== null && base.dailyRates.some((rate) => rate.amountBasis === 'NET') ? Number(((decision.totalMinor - decision.netMinor) * 10_000n) / decision.totalMinor) : null)
      return {
        dealId: deal.id, ratePlanId: rawPlan.id, currency: base.currency, eligible, reasons: [...new Set([...without.reasons, ...withDeal.reasons])], rooms,
        nights: eligible ? (withDeal.nightly ?? []).map((night) => ({ date: night.date, baseNetMinor: minor(night.netBeforeMinor), promotionMinor: minor(night.promotionMinor), supplementMinor: minor(night.supplementMinor), netMinor: minor(night.netMinor), markupMinor: minor(night.markupMinor), sellMinor: minor(night.sellMinor) })) : [],
        withoutDeal: without.eligible ? { netMinor: minor(without.netMinor), sellMinor: minor(without.totalMinor) } : null,
        withDeal: eligible ? { netMinor: minor(withDeal.netMinor), sellMinor: minor(withDeal.totalMinor) } : null,
        savingSellMinor: eligible && without.totalMinor !== null && withDeal.totalMinor !== null ? (without.totalMinor - withDeal.totalMinor).toString() : null,
        marginWithoutBp: margin(without), marginWithBp: eligible ? margin(withDeal) : null,
        dealApplied: eligible && (withDeal.promotion?.id === deal.id || withDeal.promotion?.combined?.some((member) => member.id === deal.id) === true),
        trace: (withDeal.promotionTrace ?? []).map((entry) => ({ id: entry.id, name: entry.name, outcome: entry.outcome, ...(entry.guard ? { guard: entry.guard } : {}), ...(entry.savingMinor !== undefined ? { savingMinor: (entry.savingMinor * roomsBig).toString() } : {}) })),
        asOf: now.toISOString(), writes: 'none' as const,
      }
    })
  }

  // ---- history ----------------------------------------------------------------------------------------------------------------------

  async auditTrail(tenantId: string, dealId: string): Promise<HotelDealAuditTrail> {
    const deal = await this.prisma.withTenant(tenantId, (tx) => this.load(tx, tenantId, dealId))
    const [events, approvals] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { tenantId, entityType: ENTITY_TYPE, entityId: deal.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 })),
      this.approvals.listForEntities(tenantId, ENTITY_TYPE, [deal.id]),
    ])
    return {
      dealId: deal.id,
      events: events.map((event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>
        const { requestId, ...summary } = payload
        return { id: event.id, action: event.action, actorUserId: event.userId, at: event.createdAt.toISOString(), requestId: typeof requestId === 'string' ? requestId : null, summary }
      }),
      approvals: approvals.map((approval) => ({ id: approval.id, status: approval.status, requestedById: approval.requestedById, decidedById: approval.decidedById, reason: approval.reason, decisionReason: approval.decisionReason, createdAt: approval.createdAt.toISOString(), decidedAt: approval.decidedAt?.toISOString() ?? null, executedAt: approval.executedAt?.toISOString() ?? null })),
    }
  }

  async performance(tenantId: string, dealId: string): Promise<HotelDealPerformance> {
    const deal = await this.prisma.withTenant(tenantId, (tx) => this.load(tx, tenantId, dealId))
    const view = this.view(deal)
    return {
      dealId: deal.id, status: view.status, effectiveStatus: view.effectiveStatus,
      redemptions: { available: false, reason: 'Redemptions, attributed bookings, discount value, revenue and margin need booking records. Booking is not enabled for the API runtime role, so none are recorded; nothing here is estimated.' },
      channels: [
        { channel: 'PORTAL', published: ['ACTIVE', 'SCHEDULED'].includes(deal.status) && (deal.channels.length === 0 || deal.channels.includes('PORTAL')), reason: 'Priced by the Agent portal search through the shared evaluator.' },
        { channel: 'API', published: false, reason: 'No distribution API search exists yet, so no deal is published to this channel.' },
      ],
      activation: { activatedAt: deal.activatedAt?.toISOString() ?? null, activeFrom: dayOf(deal.activeFrom), activeTo: dayOf(deal.activeTo), lastStatusChangeAt: deal.statusChangedAt?.toISOString() ?? null },
    }
  }
}
