import type { Prisma } from '@prisma/client'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import type { PrismaService } from '../database/prisma.service'
import type { PromotionRule } from './promotions'
import { CommercialControlUnavailableError, controlReadFailure } from './commercial-controls'
import { dealToRule, rowToTerms, PRICING_STATUSES, type DealRow } from './deal-model'

/**
 * ACTIVE (and SCHEDULED) hotel deals as evaluator rules, per rate plan (ADR 0089). This is the one reader every pricing surface uses: Agent search,
 * recheck and hold through `loadDealRules`, and the Admin readiness views, certification and inspector through `loadDealRulesInTx`.
 *
 * Which deals are loaded is decided by status only. Whether one applies today is decided by the evaluator against the hotel's calendar, so a stored
 * label that is a night behind never sells an expired deal or holds back a due one. A SCHEDULED deal without a start date is malformed.
 * Failure (ADR 0031): a denied or failed read, or a malformed row, throws `CommercialControlUnavailableError`; it is never an empty list.
 */
const SELECT = {
  id: true, code: true, name: true, kind: true, status: true, priority: true, percentBp: true, amountMinor: true, currency: true, amountScope: true, minNights: true, freeNights: true, fromNight: true, minLeadDays: true,
  bookFrom: true, bookTo: true, stayFrom: true, stayTo: true, weekdays: true, stayWindowMode: true, discountBase: true, combinable: true, stackingGroup: true, incompatibleDealIds: true, channels: true,
  sourceMarkets: true, agencyIds: true, maxDiscountBp: true, minSellFloorMinor: true, minMarginBp: true, activeFrom: true, activeTo: true, publicDescription: true, internalNotes: true,
} as const

type Loaded = DealRow & { id: string; status: string }
type Link = { ratePlanId: string; deal: Loaded }

const KINDS = new Set(['PERCENT_OFF', 'EARLY_BIRD', 'FLASH_SALE', 'STAY_X_PAY_Y', 'SUBSEQUENT_NIGHTS', 'EVERY_NTH_FREE', 'FIXED_OFF'])

function assertWellFormed(deal: Loaded): void {
  const ok = KINDS.has(deal.kind) && Array.isArray(deal.channels) && Array.isArray(deal.sourceMarkets) && Array.isArray(deal.agencyIds) && Array.isArray(deal.incompatibleDealIds) &&
    (deal.status !== 'SCHEDULED' || deal.activeFrom instanceof Date) && (deal.kind !== 'FIXED_OFF' || (deal.amountMinor !== null && deal.currency !== null && deal.amountScope !== null))
  if (!ok) throw new CommercialControlUnavailableError('hotel_deals', 'malformed')
}

function group(links: readonly Link[]): Map<string, PromotionRule[]> {
  const byPlan = new Map<string, PromotionRule[]>()
  for (const link of links) {
    assertWellFormed(link.deal)
    const rule = dealToRule(link.deal.id, rowToTerms(link.deal, []))
    byPlan.set(link.ratePlanId, [...(byPlan.get(link.ratePlanId) ?? []), rule])
  }
  return byPlan
}

const where = (tenantId: string, ratePlanIds: readonly string[]) => ({ tenantId, ratePlanId: { in: [...ratePlanIds] }, deal: { tenantId, status: { in: [...PRICING_STATUSES] as Array<'ACTIVE' | 'SCHEDULED'> } } })

/** Read in its own transaction so a denied read cannot poison the caller's. Plans with no deal are absent from the map: use `dealsFor`. */
export async function loadDealRules(prisma: PrismaService, tenantId: string, ratePlanIds: readonly string[]): Promise<Map<string, PromotionRule[]>> {
  if (ratePlanIds.length === 0) return new Map()
  let links: Link[]
  try {
    links = await prisma.withTenant(tenantId, (tx) => tx.hotelDealRatePlan.findMany({ where: { ...where(tenantId, ratePlanIds), tenantId }, select: { ratePlanId: true, deal: { select: SELECT } }, orderBy: [{ ratePlanId: 'asc' }, { dealId: 'asc' }] })) as Link[]
  } catch (error) {
    throw controlReadFailure('hotel_deals', error)
  }
  return group(links)
}

/**
 * The same read inside a caller's transaction, for the Admin views only (never for an offer). A SAVEPOINT keeps a denied read from aborting the caller's
 * transaction; the view then reports no deals, so it shows the plan's own price. That is a diagnostic view, not a quote.
 */
export async function loadDealRulesInTx(tx: Prisma.TransactionClient, tenantId: string, ratePlanIds: readonly string[], onDenied?: () => void): Promise<Map<string, PromotionRule[]>> {
  if (ratePlanIds.length === 0) return new Map()
  await tx.$executeRawUnsafe('SAVEPOINT hotel_deals_read')
  try {
    const links = await tx.hotelDealRatePlan.findMany({ where: { ...where(tenantId, ratePlanIds), tenantId }, select: { ratePlanId: true, deal: { select: SELECT } }, orderBy: [{ ratePlanId: 'asc' }, { dealId: 'asc' }] }) as Link[]
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT hotel_deals_read')
    return group(links)
  } catch (error) {
    if (!isBookingReadDenied(error)) throw error
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT hotel_deals_read')
    onDenied?.()
    return new Map()
  }
}

/** Attaches each plan's deals under `dealRules`, which `buildStaySnapshot` requires. A plan without a deal gets an empty list. */
export function withDealRules<T extends { id: string }>(plans: readonly T[], byPlan: ReadonlyMap<string, PromotionRule[]>): Array<T & { dealRules: PromotionRule[] }> {
  return plans.map((plan) => ({ ...plan, dealRules: byPlan.get(plan.id) ?? [] }))
}
