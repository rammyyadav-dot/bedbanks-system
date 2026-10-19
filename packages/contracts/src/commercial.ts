/**
 * Contracts for the commercial markup rules API (`/admin/commercial/markups`, ADR 0018).
 * A rule is a percent markup, in integer basis points, on NET daily rates. Rules are immutable: only the status moves.
 */
import type { ApprovalStatusName } from './operations'

export const MARKUP_MAX_BASIS_POINTS = 10_000
export type MarkupScopeName = 'TENANT_DEFAULT' | 'SUPPLIER' | 'HOTEL'
export type MarkupRuleStatusName = 'DRAFT' | 'ACTIVE' | 'RETIRED'
export const MARKUP_SCOPES: readonly MarkupScopeName[] = ['TENANT_DEFAULT', 'SUPPLIER', 'HOTEL']
export const MARKUP_STATUSES: readonly MarkupRuleStatusName[] = ['DRAFT', 'ACTIVE', 'RETIRED']

export interface MarkupApprovalView {
  id: string
  status: ApprovalStatusName
  requestedById: string
  decidedById: string | null
  decisionReason: string | null
  /** True when the caller is not the requester and the request is pending. The server enforces this regardless. */
  canDecide: boolean
  canCancel: boolean
  /** Approved and not yet used: anyone holding supply.rates.manage may activate it, once. */
  canExecute: boolean
}

export interface MarkupRuleView {
  id: string
  scope: MarkupScopeName
  supplierId: string | null
  supplierName: string | null
  hotelId: string | null
  hotelName: string | null
  /** ADR 0067 F-11: client tier (one agency) and market tier (buyer country). Null on both: a generic rule. */
  agencyId: string | null
  agencyName: string | null
  market: string | null
  excludedHotelIds: string[]
  excludedSupplierIds: string[]
  basisPoints: number
  /** First and last night the rule applies to, inclusive. validTo null is open-ended. */
  validFrom: string
  validTo: string | null
  status: MarkupRuleStatusName
  reason: string
  createdById: string
  createdAt: string
  activatedAt: string | null
  retiredAt: string | null
  /** The most recent activation request for this rule, if any. */
  approval: MarkupApprovalView | null
  /** True when the caller may request activation (a DRAFT with no open request). */
  canRequestActivation: boolean
  canRetire: boolean
}

export interface MarkupRuleCreate {
  scope: MarkupScopeName
  supplierId?: string
  hotelId?: string
  /** ADR 0067 F-11: limit the rule to one agency and/or one buyer market (ISO-3166 alpha-2). */
  agencyId?: string
  market?: string
  /** Hotels or suppliers the rule does not apply to (at most 200 each). Not on the dimension the rule targets. */
  excludedHotelIds?: string[]
  excludedSupplierIds?: string[]
  basisPoints: number
  validFrom: string
  validTo?: string
  reason: string
}
export interface MarkupActivationRequest { requestId: string; reason: string }
export interface MarkupDecision { reason: string }
export interface MarkupRulePage { items: MarkupRuleView[]; page: number; pageSize: number; total: number }
export interface MarkupActivationResult { approval: MarkupApprovalView; rule: MarkupRuleView; replacedRuleId: string | null }

/**
 * What the active markup rules do to the tenant's rate plans over a forward window (ADR 0018). Counts plan-nights of ACTIVE
 * rate plans, using each plan's own occupancy. Money is an integer minor-unit string per currency and is never added across currencies.
 */
export interface MarkupImpact {
  generatedAt: string
  window: { from: string; to: string; days: number }
  scanCapped: boolean
  totalHotels: number
  planNights: {
    /** Stored sell rates: sold as they are, never marked up. */
    sell: number
    /** NET rates a rule prices. */
    netPriced: number
    /** NET rates with no rule in force: not sellable until a rule applies. */
    netUnpriced: number
    /** Rates with no verified basis: not sellable, and no rule can fix that. */
    basisUnverified: number
  }
  /** Hotels with at least one unpriced NET plan-night, most affected first (at most ten). */
  affectedHotels: Array<{ hotelId: string; hotelName: string; unpricedNights: number }>
  affectedHotelCount: number
  /** For priced NET nights: the supplier cost and the markup added, per currency. */
  currencies: Array<{ currency: string; netMinor: string; markupMinor: string }>
  definitions: Record<string, string>
}

/**
 * Controlled FX rates (`/admin/commercial/fx-rates`, ADR 0067 F-12). A rate converts a contract's settlement currency (base) into the
 * currency an agent searches and books in (quote). Rates are immutable: only the status moves, and DRAFT becomes ACTIVE only through a second
 * person's approval. One ACTIVE rate per pair; activating a rate retires the one it replaces. Without an ACTIVE rate the contract is not
 * offered in that currency.
 */
export type FxRateStatusName = 'DRAFT' | 'ACTIVE' | 'RETIRED'
export const FX_RATE_STATUSES: readonly FxRateStatusName[] = ['DRAFT', 'ACTIVE', 'RETIRED']
/** The largest buffer (basis points added on top of the rate to cover movement until settlement): 20%. */
export const FX_MAX_BUFFER_BP = 2000

export interface FxRateView {
  id: string
  baseCurrency: string
  quoteCurrency: string
  /** Quote major units per one base major unit, as a decimal string with eight places (e.g. "0.27229000"). */
  rate: string
  bufferBp: number
  /** The rate with the buffer applied, as frozen on a booking. */
  effectiveRate: string
  status: FxRateStatusName
  reason: string
  createdById: string
  createdAt: string
  activatedAt: string | null
  retiredAt: string | null
  approval: MarkupApprovalView | null
  canRequestActivation: boolean
  canRetire: boolean
}

export interface FxRateCreate {
  baseCurrency: string
  quoteCurrency: string
  /** A positive decimal with at most eight places, as a string so no float touches it. */
  rate: string
  bufferBp?: number
  reason: string
}
export interface FxRatePage { items: FxRateView[]; page: number; pageSize: number; total: number }
export interface FxActivationResult { approval: MarkupApprovalView; rate: FxRateView; replacedRateId: string | null }
