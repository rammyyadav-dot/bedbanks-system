/**
 * Hotel deals and promotions (ADR 0089). Admin routes under `/admin/commercial/promotions`; tenant identity comes from the session, never from a body.
 * Money is integer minor units sent as decimal strings; a percentage is basis points. Reads need `supply.rates.read`, every change `supply.rates.manage`;
 * activation additionally needs a different person's approval (`promotion.activate`, enforced by the approval service).
 */
export const HOTEL_DEAL_KINDS = ['PERCENT_OFF', 'EARLY_BIRD', 'FLASH_SALE', 'STAY_X_PAY_Y', 'SUBSEQUENT_NIGHTS', 'EVERY_NTH_FREE', 'FIXED_OFF'] as const
export type HotelDealKind = (typeof HOTEL_DEAL_KINDS)[number]

export const HOTEL_DEAL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'EXPIRED', 'ARCHIVED'] as const
export type HotelDealStatus = (typeof HOTEL_DEAL_STATUSES)[number]

export const HOTEL_DEAL_CHANNELS = ['PORTAL', 'API'] as const
export type HotelDealChannel = (typeof HOTEL_DEAL_CHANNELS)[number]

export const HOTEL_DEAL_APPROVAL_ACTION = 'promotion.activate'

/** What each supported type does, in the words the form and the details page use. */
export const HOTEL_DEAL_KIND_INFO: Readonly<Record<HotelDealKind, { label: string; description: string }>> = {
  PERCENT_OFF: { label: 'Percent off', description: 'A percentage off the nightly net of every eligible night.' },
  EARLY_BIRD: { label: 'Early bird', description: 'A percentage off for bookings made at least a number of days before check-in.' },
  FLASH_SALE: { label: 'Flash sale', description: 'A percentage off inside a limited booking window. Both ends of the window are required.' },
  STAY_X_PAY_Y: { label: 'Stay X pay Y', description: 'Stay X nights and the cheapest X minus Y nights are free, once per stay.' },
  SUBSEQUENT_NIGHTS: { label: 'Discount on subsequent nights', description: 'Early nights keep their price; a percentage comes off from a chosen night onward.' },
  EVERY_NTH_FREE: { label: 'Free night', description: 'One cheapest night is free for every full block of N nights.' },
  FIXED_OFF: { label: 'Fixed amount off', description: 'A fixed amount in the plan currency, per night or once per stay. Never below one minor unit per night.' },
}
/** Offered by the brief, not implementable on the existing model. The Admin shows it as unavailable; the API refuses it with PROMOTION_TYPE_UNSUPPORTED. */
export const HOTEL_DEAL_UNSUPPORTED_KINDS: ReadonlyArray<{ kind: string; label: string; reason: string }> = [
  { kind: 'PACKAGE_ADD_ON', label: 'Package add-on', reason: 'It changes what is sold (an included extra), not the price. The contract model has no priced inclusion to attach it to.' },
]

export interface HotelDealTerms {
  code: string
  name: string
  kind: HotelDealKind
  /** 0 to 100. Only breaks a tie between equal savings; it never overrides a guard or a larger saving. */
  priority: number
  percentBp: number | null
  /** FIXED_OFF: minor units as a decimal string. */
  amountMinor: string | null
  currency: string | null
  amountScope: 'PER_NIGHT' | 'PER_STAY' | null
  minNights: number | null
  freeNights: number | null
  fromNight: number | null
  minLeadDays: number | null
  bookFrom: string | null
  bookTo: string | null
  stayFrom: string | null
  stayTo: string | null
  /** 0 Monday to 6 Sunday of the night. Empty means every day. */
  weekdays: number[]
  stayWindowMode: 'WHOLE_STAY' | 'NIGHTS_IN_WINDOW'
  discountBase: 'ROOM_AND_GUESTS' | 'ROOM_ONLY'
  combinable: boolean
  stackingGroup: string | null
  incompatibleDealIds: string[]
  /** Empty means every channel. */
  channels: HotelDealChannel[]
  /** ISO-3166 alpha-2 buyer markets. Empty means every market. */
  sourceMarkets: string[]
  /** Explicit agencies. Empty means every agency. */
  agencyIds: string[]
  maxDiscountBp: number | null
  minSellFloorMinor: string | null
  minMarginBp: number | null
  /** The deal's own effective window in the hotel's calendar, inclusive. */
  activeFrom: string | null
  activeTo: string | null
  publicDescription: string | null
  internalNotes: string | null
  ratePlanIds: string[]
}

/** POST body of create: the full terms plus the hotel and an idempotency key. Unknown fields are refused (400 DEAL_FIELD_NOT_ALLOWED). */
export type HotelDealCreateInput = Partial<Omit<HotelDealTerms, 'code' | 'name' | 'kind' | 'ratePlanIds'>> & Pick<HotelDealTerms, 'code' | 'name' | 'kind' | 'ratePlanIds'> & { hotelId: string; idempotencyKey: string }
/** PUT body of a draft: the full terms again, and the version being replaced. */
export type HotelDealReplaceInput = Partial<Omit<HotelDealTerms, 'code' | 'name' | 'kind' | 'ratePlanIds'>> & Pick<HotelDealTerms, 'code' | 'name' | 'kind' | 'ratePlanIds'> & { expectedVersion: number }

export interface HotelDealIssue { code: string; field?: string; message: string; severity: 'ERROR' | 'WARNING' }

export interface HotelDealApprovalView {
  id: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXECUTED' | 'EXPIRED'
  requestedById: string
  decidedById: string | null
  decisionReason: string | null
  reason: string
  canDecide: boolean
  canCancel: boolean
  canExecute: boolean
}

export interface HotelDealView {
  id: string
  hotelId: string
  hotelName: string
  code: string
  name: string
  kind: HotelDealKind
  /** The stored status. */
  status: HotelDealStatus
  /** What applies today in the hotel's calendar (a SCHEDULED deal whose start has passed reads ACTIVE; one whose end has passed reads EXPIRED). */
  effectiveStatus: HotelDealStatus
  version: number
  percentBp: number | null
  amountMinor: string | null
  currency: string | null
  activeFrom: string | null
  activeTo: string | null
  planCount: number
  statusReason: string | null
  createdById: string
  createdAt: string
  updatedAt: string
  activatedAt: string | null
}

export interface HotelDealCapabilities {
  canEdit: boolean
  canValidate: boolean
  canPreview: boolean
  canSubmit: boolean
  canWithdraw: boolean
  canApprove: boolean
  canReject: boolean
  canActivate: boolean
  canPause: boolean
  canResume: boolean
  canSuspend: boolean
  canReturnToDraft: boolean
  canArchive: boolean
}

export interface HotelDealPlanRef { id: string; code: string; status: string; currency: string; roomTypeId: string; roomTypeName: string; contractStatus: string }

export interface HotelDealDetail extends HotelDealView {
  terms: HotelDealTerms
  ratePlans: HotelDealPlanRef[]
  /** SHA-256 of the canonical terms: what an approval is bound to. Null until the deal has been submitted. */
  termsFingerprint: string | null
  approval: HotelDealApprovalView | null
  validation: HotelDealIssue[]
  capabilities: HotelDealCapabilities
}

export interface HotelDealPage { items: HotelDealView[]; page: number; pageSize: number; total: number }

export interface HotelDealSummary {
  total: number
  /** Counts by what applies today. Archived deals are counted under ARCHIVED. */
  byStatus: Record<HotelDealStatus, number>
  /** True when the tenant has more deals than the summary reads. */
  truncated: boolean
}

export interface HotelDealSubmitInput { expectedVersion: number; requestId: string; reason: string }
export interface HotelDealDecisionInput { reason: string }
export interface HotelDealTransitionInput { expectedVersion: number; reason?: string }

export interface HotelDealPreviewInput {
  ratePlanId: string
  checkIn: string
  nights: number
  adults?: number
  children?: number
  childAges?: number[]
  rooms?: number
  /** The booking day in the hotel's calendar; defaults to today. */
  bookingDate?: string
  market?: string
  nationality?: string
  agencyId?: string
  channel?: HotelDealChannel
}

export interface HotelDealPreviewNight { date: string; baseNetMinor: string; promotionMinor: string; supplementMinor: string; netMinor: string; markupMinor: string; sellMinor: string }
export interface HotelDealTraceEntry { id: string; name: string; outcome: 'APPLIED' | 'NOT_ELIGIBLE' | 'NO_SAVING' | 'GUARD_BREACHED' | 'OUTRANKED' | 'EXCLUDED_BY_STACK_RULE'; guard?: string; savingMinor?: string }
export interface HotelDealPreviewResult {
  dealId: string
  ratePlanId: string
  currency: string
  /** False when the base stay itself is not sellable; then no price is shown and `reasons` says why. Never a fabricated discount. */
  eligible: boolean
  reasons: string[]
  rooms: number
  nights: HotelDealPreviewNight[]
  /** Totals for all rooms, with and without this deal. */
  withoutDeal: { netMinor: string; sellMinor: string } | null
  withDeal: { netMinor: string; sellMinor: string } | null
  savingSellMinor: string | null
  /** Margin on the sell price in basis points, with and without the deal. Null for a SELL-basis rate (no supplier net is known). */
  marginWithoutBp: number | null
  marginWithBp: number | null
  dealApplied: boolean
  trace: HotelDealTraceEntry[]
  asOf: string
  writes: 'none'
}

export interface HotelDealAuditEntry { id: string; action: string; actorUserId: string | null; at: string; requestId: string | null; summary: Record<string, unknown> }
export interface HotelDealAuditTrail { dealId: string; events: HotelDealAuditEntry[]; approvals: Array<{ id: string; status: string; requestedById: string; decidedById: string | null; reason: string; decisionReason: string | null; createdAt: string; decidedAt: string | null; executedAt: string | null }> }

export interface HotelDealPerformance {
  dealId: string
  status: HotelDealStatus
  effectiveStatus: HotelDealStatus
  /** Redemptions, attributed bookings, discount value, revenue and margin need the booking tables, which the API runtime role does not hold: reported as unavailable, never estimated. */
  redemptions: { available: false; reason: string }
  channels: Array<{ channel: HotelDealChannel; published: boolean; reason: string }>
  activation: { activatedAt: string | null; activeFrom: string | null; activeTo: string | null; lastStatusChangeAt: string | null }
}

export interface HotelDealReconcileResult { activated: number; expired: number; examined: number; ids: { activated: string[]; expired: string[] } }

export interface HotelDealApprovalQueueItem { deal: HotelDealView; approval: HotelDealApprovalView; validation: HotelDealIssue[]; ratePlanCount: number; summary: string }
