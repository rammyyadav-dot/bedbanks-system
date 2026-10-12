/**
 * Rate-plan activation readiness (Draft/Suspended -> Active).
 *
 * Pure and transport-agnostic: the service loads plain facts, this module decides. It never reads the
 * database, never infers a missing rate, and never treats unknown data as ready. Dates are YYYY-MM-DD
 * strings so no timezone arithmetic can shift a night.
 */

export type RatePlanStatusValue = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'
export type RatePlanAction = 'activate' | 'suspend'

export interface ActivationCheck {
  code: string
  label: string
  ok: boolean
  /** Actionable text when the check fails; the supporting fact when it passes. */
  message: string
}

export interface ActivationReadiness {
  ready: boolean
  checks: ActivationCheck[]
}

export interface ActivationFacts {
  /** Today in the hotel's calendar, YYYY-MM-DD. The caller supplies it so the evaluator stays deterministic. */
  today: string
  plan: { status: RatePlanStatusValue; currency: string; occupancy: number; refundable: boolean; minStay: number; maxStay: number | null; inventoryPoolId: string | null; validFrom: string | null; validTo: string | null; cancellationPolicySet: string | null; markets: { salesMarkets: string[] | null; nationalities: string[] | null } }
  room: { hotelId: string; maxOccupancy: number; isActive: boolean }
  board: { isActive: boolean }
  contract: {
    status: string; validFrom: string; validTo: string; settlementCurrency: string
    mappedHotelId: string | null; cancellationPolicyCount: number; markets: { salesMarkets: string[] | null; nationalities: string[] | null }
  }
  /** Daily rows for the plan's own occupancy from `today` onward. */
  rates: Array<{ stayDate: string; amountBasis: string | null; currency: string; amountMinor: bigint }>
  /** Child and extra-adult lines (ADR 0057, S6). Empty means the plan keeps the flat-occupancy rule. */
  guestPrices: GuestPriceLine[]
  /** Future availability rows for the plan. */
  availabilityDates: string[]
}

import { codesOutsideContract } from './market-rules'
import { validateGuestPriceLines, type GuestPriceLine } from './guest-pricing'

const DAY_MS = 86_400_000
const addDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)

/** Nights missing between the first and last rated date. Reported, never filled. */
export function rateGaps(dates: readonly string[]): string[] {
  const sorted = [...new Set(dates)].sort()
  if (sorted.length < 2) return []
  const have = new Set(sorted)
  const gaps: string[] = []
  for (let day = addDay(sorted[0]!); day < sorted[sorted.length - 1]!; day = addDay(day)) if (!have.has(day)) gaps.push(day)
  return gaps
}

const check = (code: string, label: string, ok: boolean, pass: string, fail: string): ActivationCheck => ({ code, label, ok, message: ok ? pass : fail })

export function assessRatePlanActivation(facts: ActivationFacts): ActivationReadiness {
  const { plan, room, board, contract, rates, today } = facts
  const checks: ActivationCheck[] = []

  checks.push(check('STATUS_ALLOWED', 'Lifecycle state', plan.status === 'DRAFT' || plan.status === 'SUSPENDED', `Plan is ${plan.status}.`,
    plan.status === 'ACTIVE' ? 'Plan is already active.' : 'An expired plan cannot be reactivated; clone it into a new draft.'))

  checks.push(check('CONTRACT_MAPPED', 'Hotel and contract link', contract.mappedHotelId !== null && contract.mappedHotelId === room.hotelId, 'Contract is mapped to the room\'s hotel.',
    contract.mappedHotelId === null ? 'The contract has no supplier-hotel mapping, so its hotel cannot be verified.' : 'The contract is mapped to a different hotel than the room.'))

  checks.push(check('CONTRACT_ACTIVE', 'Contract status', contract.status === 'ACTIVE', 'Contract is active.', `Contract is ${contract.status}; only an active contract can back a sellable plan.`))
  checks.push(check('CONTRACT_VALID', 'Contract validity', contract.validFrom <= contract.validTo && contract.validTo >= today, `Contract is valid ${contract.validFrom} to ${contract.validTo}.`,
    contract.validTo < today ? `Contract ended on ${contract.validTo}.` : 'Contract validity dates are inverted.'))
  // ADR 0057: the plan's own sale window must sit inside the contract term and not already be over. A null side inherits the contract.
  const windowInside = (plan.validFrom === null || plan.validFrom >= contract.validFrom) && (plan.validTo === null || plan.validTo <= contract.validTo)
  const windowOrdered = plan.validFrom === null || plan.validTo === null || plan.validFrom <= plan.validTo
  const windowOpen = plan.validTo === null || plan.validTo >= today
  checks.push(check('PLAN_VALIDITY', 'Plan sale window', windowInside && windowOrdered && windowOpen,
    plan.validFrom === null && plan.validTo === null ? 'Plan inherits the contract term.' : `Plan is on sale ${plan.validFrom ?? contract.validFrom} to ${plan.validTo ?? contract.validTo}.`,
    !windowOrdered ? 'The plan sale window is inverted.' : !windowInside ? 'The plan sale window extends outside the contract term.' : `The plan sale window ended on ${plan.validTo}.`))
  // ADR 0057 S3: plan buyer lists must be well formed and can only narrow the contract's own lists.
  const pm = plan.markets, cm = contract.markets
  const marketsMalformed = pm.salesMarkets === null || pm.nationalities === null
  const marketsOutside = marketsMalformed ? [] : [...codesOutsideContract(pm.salesMarkets!, cm.salesMarkets ?? []), ...codesOutsideContract(pm.nationalities!, cm.nationalities ?? [])]
  checks.push(check('PLAN_MARKETS', 'Plan buyer markets', !marketsMalformed && marketsOutside.length === 0,
    pm.salesMarkets && pm.nationalities && pm.salesMarkets.length + pm.nationalities.length > 0 ? 'Plan is restricted to its listed buyer markets and nationalities, inside the contract.' : 'Plan adds no buyer restriction beyond the contract.',
    marketsMalformed ? 'The plan sales-market or nationality list is malformed.' : `The plan lists ${marketsOutside.join(', ')} which the contract does not allow, so it could never sell to them.`))
  checks.push(check('CURRENCY_MATCH', 'Currency', plan.currency === contract.settlementCurrency, `Plan and contract both use ${plan.currency}.`,
    `Plan currency ${plan.currency} differs from contract settlement currency ${contract.settlementCurrency}.`))

  checks.push(check('ROOM_ACTIVE', 'Room readiness', room.isActive, 'Room type is active.', 'The room type is archived or inactive.'))
  checks.push(check('OCCUPANCY_VALID', 'Occupancy', Number.isInteger(plan.occupancy) && plan.occupancy >= 1 && plan.occupancy <= room.maxOccupancy, `Occupancy ${plan.occupancy} fits the room (max ${room.maxOccupancy}).`,
    `Occupancy ${plan.occupancy} is outside 1-${room.maxOccupancy} for this room.`))
  checks.push(check('BOARD_ACTIVE', 'Board basis', board.isActive, 'Board basis is active.', 'The board basis is inactive.'))
  checks.push(check('STAY_RULES_VALID', 'Stay rules', plan.minStay >= 1 && (plan.maxStay === null || plan.maxStay >= plan.minStay), 'Minimum and maximum stay are consistent.', 'Maximum stay is below minimum stay.'))

  // A refundable plan must point at a real cancellation schedule; a non-refundable plan carries none by design. Never substitute a default.
  checks.push(check('CANCELLATION_POLICY', 'Cancellation policy', !plan.refundable || contract.cancellationPolicyCount > 0,
    plan.refundable ? `${contract.cancellationPolicyCount} cancellation rule(s) in ${plan.cancellationPolicySet ? `set "${plan.cancellationPolicySet}"` : 'the contract default'}.` : 'Non-refundable plan.',
    plan.cancellationPolicySet ? `The plan names cancellation set "${plan.cancellationPolicySet}" but the contract has no rules in it.` : 'A refundable plan needs at least one cancellation rule on its contract. Add one, or mark the plan non-refundable.'))

  const future = rates.filter((row) => row.stayDate >= today)
  const unclassified = future.filter((row) => row.amountBasis === null)
  const wrongCurrency = future.filter((row) => row.currency !== plan.currency)
  const nonPositive = future.filter((row) => row.amountMinor <= 0n)
  const gaps = rateGaps(future.map((row) => row.stayDate))
  checks.push(check('RATES_PRESENT', 'Rate calendar coverage', future.length > 0, `${future.length} dated rate(s) from ${today}.`, `No rate exists from ${today} for occupancy ${plan.occupancy}.`))
  checks.push(check('RATES_CONTIGUOUS', 'No missing nights', gaps.length === 0, 'No gaps between the first and last rated night.', `${gaps.length} unrated night(s) inside the rated range, first ${gaps[0]}.`))
  checks.push(check('RATES_CLASSIFIED', 'Rate basis', unclassified.length === 0, 'Every rate is classified as NET or SELL.', `${unclassified.length} rate(s) have no NET/SELL classification, first ${unclassified[0]?.stayDate}.`))
  checks.push(check('RATES_CURRENCY', 'Rate currency', wrongCurrency.length === 0, 'Every rate is in the plan currency.', `${wrongCurrency.length} rate(s) are not in ${plan.currency}, first ${wrongCurrency[0]?.stayDate}.`))
  checks.push(check('RATES_POSITIVE', 'Rate amounts', nonPositive.length === 0, 'Every rate is a positive amount.', `${nonPositive.length} rate(s) are zero or negative, first ${nonPositive[0]?.stayDate}.`))

  // ADR 0057, S6: the lines must be a coherent price list and share the basis of the rates they are added to, or every night they touch would be refused.
  const lineIssues = validateGuestPriceLines(facts.guestPrices, plan.currency)
  const rateBases = new Set(future.map((row) => row.amountBasis).filter((basis): basis is string => basis !== null))
  const basisMismatch = facts.guestPrices.length > 0 && facts.guestPrices.some((line) => [...rateBases].some((basis) => basis !== line.basis))
  checks.push(check('GUEST_PRICES_VALID', 'Child and extra-adult prices', lineIssues.length === 0 && !basisMismatch,
    facts.guestPrices.length === 0 ? 'No guest price lines: the plan sells its flat occupancy.' : `${facts.guestPrices.length} guest price line(s), consistent with the rates.`,
    lineIssues.length ? `${lineIssues[0]!.message}${lineIssues.length > 1 ? ` (${lineIssues.length} problems)` : ''}` : 'A guest price line has a different basis (NET or SELL) than the rates it is added to.'))

  const futureAvailability = facts.availabilityDates.filter((day) => day >= today)
  checks.push(check('INVENTORY_LINKED', 'Inventory linkage', plan.inventoryPoolId !== null || futureAvailability.length > 0,
    plan.inventoryPoolId ? 'Plan draws from a shared inventory pool.' : `${futureAvailability.length} availability row(s) from ${today}.`,
    'The plan has neither a shared inventory pool nor any future availability row; unknown inventory is not sellable.'))

  return { ready: checks.every((item) => item.ok), checks }
}

/** Activation needs a ready checklist as well; suspension only applies to an active plan. Expired is terminal. */
export function transitionTarget(action: RatePlanAction, from: RatePlanStatusValue): RatePlanStatusValue | null {
  if (action === 'activate') return from === 'DRAFT' || from === 'SUSPENDED' ? 'ACTIVE' : null
  return from === 'ACTIVE' ? 'SUSPENDED' : null
}

/** Clone keeps the commercial shape but never identity, status, rates or stock. */
export function cloneDraftFields(
  source: { contractId: string; roomTypeId: string; boardBasisId: string; occupancy: number; currency: string; refundable: boolean; taxesIncluded: boolean; feesIncluded: boolean; minStay: number; maxStay: number | null; releaseDays: number; releaseTimeLocal: string; validFrom: Date | null; validTo: Date | null; paymentType: 'PREPAID' | 'PAY_AT_HOTEL' | null; cancellationPolicySet: string | null; salesMarkets: unknown; nationalities: unknown },
  overrides: { code: string; roomTypeId?: string },
) {
  return {
    contractId: source.contractId, roomTypeId: overrides.roomTypeId ?? source.roomTypeId, boardBasisId: source.boardBasisId, code: overrides.code,
    status: 'DRAFT' as const, occupancy: source.occupancy, currency: source.currency, refundable: source.refundable, taxesIncluded: source.taxesIncluded,
    feesIncluded: source.feesIncluded, minStay: source.minStay, maxStay: source.maxStay, releaseDays: source.releaseDays, releaseTimeLocal: source.releaseTimeLocal,
    validFrom: source.validFrom, validTo: source.validTo, paymentType: source.paymentType, cancellationPolicySet: source.cancellationPolicySet, salesMarkets: source.salesMarkets, nationalities: source.nationalities,
  }
}
