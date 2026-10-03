/**
 * Hotel commercial operations contracts (`/admin/operations/hotels*`, `/admin/operations/exceptions`).
 *
 * Every state here is computed server-side by the same evaluator the Agent uses (`evaluateContractedStay`).
 * The Admin renders these values; it never derives readiness, expiry or sellability itself.
 * Money is integer minor units (strings) plus an ISO-4217 currency.
 */

/** One server-side threshold for "contract expiring". Every page and filter uses it. */
export const CONTRACT_EXPIRING_DAYS = 30
/** Expiry windows offered as filters. */
export const CONTRACT_EXPIRY_FILTER_DAYS = [7, 30, 60, 90] as const
export const COMMERCIAL_WINDOW_DEFAULT_DAYS = 30
export const COMMERCIAL_WINDOW_MAX_DAYS = 90

export type CommercialReadiness = 'READY' | 'PARTIAL' | 'BLOCKED'
export type MappingState = 'MAPPED' | 'PENDING' | 'REJECTED' | 'NONE'
/** ACTIVE: in force and not near its end. EXPIRING: in force, ends within CONTRACT_EXPIRING_DAYS. EXPIRED: ended or marked EXPIRED. INACTIVE: DRAFT / REVIEW / SUSPENDED. NONE: no contract. */
export type ContractState = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'INACTIVE' | 'NONE'
export type SupplyDataState = 'OK' | 'GAPS' | 'NONE'
export type InventoryState = 'OK' | 'GAPS' | 'STOP_SELL' | 'EXHAUSTED' | 'NONE'
export type IssueSeverity = 'CRITICAL' | 'HIGH' | 'WARNING'
export type HotelSection = 'overview' | 'rooms' | 'mappings' | 'contracts' | 'rates' | 'sellability'

/**
 * Categories are a closed set derived from canonical reason codes. `UNMAPPED_HOTEL` and `UNMAPPED_ROOM` both carry the canonical
 * `SUPPLIER_MAPPING_INVALID` reason; the category records which mapping failed.
 */
export const COMMERCIAL_ISSUE_CATEGORIES = [
  'UNMAPPED_HOTEL', 'UNMAPPED_ROOM', 'CONTRACT_EXPIRED', 'CONTRACT_EXPIRING', 'RATE_MISSING', 'RATE_INVALID', 'AVAILABILITY_MISSING',
  'STOP_SELL', 'INVENTORY_EXHAUSTED', 'OCCUPANCY_UNSUPPORTED', 'CURRENCY_OR_BASIS', 'ENTITY_INACTIVE', 'HOTEL_CONTENT',
] as const
export type CommercialIssueCategory = (typeof COMMERCIAL_ISSUE_CATEGORIES)[number]

/**
 * The Agent silently skips a hotel with no 1-5 star rating. Admin surfaces that as an explicit diagnostic so a hotel is never
 * "ready" in Admin yet invisible to Agents. It is the only code that is not part of `evaluateContractedStay`.
 */
export const HOTEL_STAR_RATING_MISSING = 'HOTEL_STAR_RATING_MISSING'

/** Plain-language wording for every canonical reason code, shared by the API (issue messages) and the Admin (chips and legends). */
export const COMMERCIAL_REASON_TEXT: Record<string, string> = {
  HOTEL_INACTIVE: 'Hotel content is not COMPLETE', HOTEL_STAR_RATING_MISSING: 'Hotel has no 1-5 star rating, so Agents cannot list it',
  ROOM_TYPE_INACTIVE: 'Room type is inactive', BOARD_BASIS_INACTIVE: 'Board basis is inactive', SUPPLIER_INACTIVE: 'Supplier is not ACTIVE', RATE_PLAN_INACTIVE: 'Rate plan is not ACTIVE',
  RATE_PLAN_MISSING: 'No rate plan is configured', CONTRACT_INACTIVE: 'Contract is not ACTIVE', OUTSIDE_CONTRACT_VALIDITY: 'Date is outside the contract validity',
  SUPPLIER_MAPPING_INVALID: 'Supplier mapping is missing or not approved', OCCUPANCY_UNSUPPORTED: 'Rate plan occupancy exceeds what the room supports',
  DAILY_RATE_MISSING_OR_INVALID: 'Daily rate is missing or invalid', RATE_CURRENCY_MISMATCH: 'Rate currency differs from the plan or contract currency',
  RATE_AMOUNT_BASIS_UNVERIFIED: 'Rate amount basis is not verified', NET_RATE_MARKUP_UNAVAILABLE: 'Net rate has no markup rule, so no sell price exists',
  AVAILABILITY_MISSING: 'No availability row is loaded', STOP_SELL: 'Stop-sell is active', NO_INVENTORY: 'No inventory remains (allotment - sold - held = 0)',
  MIN_STAY_NOT_MET: 'Minimum stay is not met', MAX_STAY_EXCEEDED: 'Maximum stay is exceeded', RELEASE_DAYS_NOT_MET: 'Inside the release period', CLOSED_TO_ARRIVAL: 'Closed to arrival on the check-in date',
}

export interface CommercialIssue {
  /** Deterministic: hotel | room | plan | reason, so the same condition keeps the same id between requests. */
  id: string
  severity: IssueSeverity
  category: CommercialIssueCategory
  /** Canonical reason code (see `evaluateContractedStay`), or HOTEL_STAR_RATING_MISSING, or null for pure expiry warnings. */
  reason: string | null
  hotelId: string; hotelName: string
  roomTypeId: string | null; roomName: string | null
  ratePlanId: string | null; ratePlanCode: string | null
  supplierId: string | null; supplierName: string | null
  /** Affected night range inside the assessed window (inclusive), when the issue is date-specific. */
  from: string | null; to: string | null; nights: number
  /** Hotel 360 section that resolves it. */
  section: HotelSection
  message: string
  observedAt: string
}

export interface HotelSupplierRef { id: string; displayName: string }
/** Profile summary for one directory row (ADR 0021). The row's `profile` is null when the API database role cannot read profiles. */
export interface HotelRowProfile {
  /** False until the first Hotel Setup save; completeness is still computed from the hotel record. */
  exists: boolean
  completenessPercent: number
  publishable: boolean
  starVerified: boolean
  area: string | null
  /** Name or email of the last person to save the setup. */
  updatedBy: string | null
  externalIdentifiers: Array<{ scheme: string; value: string }>
}

export interface HotelCommercialRow {
  id: string; name: string; /** Hotel.externalRef */ code: string | null
  /** Approved (MAPPED) supplier hotel mappings. A hotel may have several. */
  verifiedMappings: number
  profile: HotelRowProfile | null
  city: string; countryCode: string; starRating: number | null; propertyType: string
  /** Entity status (`Hotel.contentStatus`). Not commercial readiness. */
  contentStatus: string
  suppliers: HotelSupplierRef[]
  contractState: ContractState; contractDaysToExpiry: number | null
  hotelMapping: MappingState
  rooms: { total: number; active: number; mapped: number }
  ratePlans: { total: number; active: number }
  rates: SupplyDataState; inventory: InventoryState
  readiness: CommercialReadiness
  /** Canonical reasons across the window, most frequent first (max 5). */
  blockers: string[]
  issues: { total: number; critical: number; high: number; warning: number }
  updatedAt: string
}
export interface HotelCommercialQuery {
  search?: string; destination?: string; supplierId?: string; contentStatus?: string
  readiness?: CommercialReadiness; mapping?: MappingState; contractState?: ContractState
  /** Canonical reason code or issue category. */
  issue?: string
  /** Contracts that end within N days (7 | 30 | 60 | 90). */
  expiresWithinDays?: number
  from?: string; days?: number; page?: number; pageSize?: number
}
/** Present when a computed filter had to scan the bounded hotel set (cap) rather than the whole tenant. */
export interface HotelCommercialPage { items: HotelCommercialRow[]; profilesAvailable: boolean; page: number; pageSize: number; total: number; window: { from: string; to: string; days: number }; scanCapped: boolean; destinations: string[] }

export interface HotelCommercialSummary {
  generatedAt: string
  window: { from: string; to: string; days: number }
  scanCapped: boolean
  totalHotels: number
  readiness: { ready: number; partial: number; blocked: number }
  mappingIssueHotels: number
  rateGapHotels: number
  availabilityGapHotels: number
  /** Hotels where at least one assessed plan-night is on stop-sell. */
  stopSellHotels: number
  /** Hotels with an ACTIVE contract ending inside CONTRACT_EXPIRING_DAYS. */
  contractsExpiring: number
  contractsExpired: number
  contractExpiringDays: number
  definitions: Record<string, string>
}

// ---- Hotel 360 ---------------------------------------------------------------------------------------------------
export type GateState = 'PASS' | 'FAIL' | 'WARN' | 'NA'
export interface ReadinessGate { key: string; label: string; state: GateState; detail: string; section: HotelSection }

export interface RoomCommercialRow {
  id: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; isActive: boolean
  /** MAPPED if any approved mapping exists under the hotel's supplier mappings; otherwise the most advanced status; NONE if unmapped. */
  mapping: MappingState
  supplierRoomIds: string[]
  ratePlans: { total: number; active: number }
  inventory: InventoryState
  readiness: CommercialReadiness
  blockers: string[]
}

export interface HotelCommercial360 {
  generatedAt: string
  window: { from: string; to: string; days: number }
  hotel: {
    id: string; name: string; code: string | null; city: string; countryCode: string; starRating: number | null; propertyType: string
    contentStatus: string; timeZone: string; address: string | null; updatedAt: string
  }
  suppliers: HotelSupplierRef[]
  readiness: CommercialReadiness
  /** True when the Agent would currently list at least one offer for some night in the window (same evaluator). */
  agentSellable: boolean
  blockers: string[]
  gates: ReadinessGate[]
  rooms: RoomCommercialRow[]
  issues: CommercialIssue[]
  counts: { bookings: number | null; activeHolds: number | null }
  contractState: ContractState
  hotelMapping: MappingState
}

/** `provenance` is the mapping's recorded `sourceMetadata.source` when it is a short string; raw source metadata is never returned. */
export interface HotelMappingRow { id: string; supplierId: string; supplierName: string; supplierHotelId: string; status: string; confidence: number | null; provenance: string | null; createdAt: string; updatedAt: string }
export interface RoomMappingRow { id: string; hotelMappingId: string; roomTypeId: string; roomName: string; supplierRoomId: string; status: string; confidence: number | null; provenance: string | null; createdAt: string; updatedAt: string }
export interface HotelMappingsView { hotelMappings: HotelMappingRow[]; roomMappings: RoomMappingRow[]; unmappedRooms: Array<{ roomTypeId: string; roomName: string; hotelMappingId: string; supplierName: string }> }

export interface HotelContractRow {
  id: string; code: string; supplierId: string; supplierName: string; status: string; state: ContractState
  validFrom: string; validTo: string; daysToExpiry: number; currency: string; version: number; updatedAt: string
  ratePlans: { total: number; active: number }
  /** null when the API database role cannot read the policy tables (reported as unavailable, never as zero). */
  policies: { cancellation: number; child: number; leadTime: number } | null
  /** Contract linked to this hotel through a mapping, or reached only through its rate plans. */
  link: 'MAPPING' | 'RATE_PLAN'
  mappingId: string | null
  /** Recorded sales markets and nationalities. They are stored on the contract but Agent search does not apply them yet, so they restrict nothing today. */
  salesMarkets: string[]
  nationalities: string[]
}
export interface HotelRatePlanRow {
  id: string; code: string; status: string; contractId: string; contractCode: string
  roomTypeId: string; roomName: string; boardBasisId: string; boardCode: string; boardActive: boolean
  occupancy: number; currency: string; refundable: boolean; minStay: number; maxStay: number | null; releaseDays: number
  /** Share of window nights by canonical outcome. */
  window: { nights: number; sellable: number; rateMissing: number; availabilityMissing: number; stopSell: number; exhausted: number; blockedOther: number }
  /** Amount basis seen on loaded rates in the window: SELL, NET, UNVERIFIED, or MIXED. */
  amountBasis: 'SELL' | 'NET' | 'UNVERIFIED' | 'MIXED' | 'NONE'
  readiness: CommercialReadiness
}
export interface HotelContractsView { contracts: HotelContractRow[]; ratePlans: HotelRatePlanRow[]; expiringDays: number }

export interface CalendarCell {
  date: string
  rateMinor: string | null; currency: string | null; amountBasis: 'SELL' | 'NET' | null
  allotment: number | null; sold: number | null; held: number | null
  /** allotment - sold - held, computed with the canonical formula; null when no availability row exists. */
  remaining: number | null
  stopSell: boolean | null; closedToArrival: boolean | null; minStay: number | null
  /** Stored, but not applied by the evaluator or Agent search, so it blocks nothing today. */
  closedToDeparture: boolean | null
  /** When the supplier last updated this night's rate and availability, if the source recorded it. A missing value means unknown, not fresh. */
  rateSourceUpdatedAt: string | null; availabilitySourceUpdatedAt: string | null
  sellable: boolean
  /** Canonical reasons for this night (stay-length rules excluded). */
  reasons: string[]
}
export interface CalendarRow {
  ratePlanId: string; ratePlanCode: string; planStatus: string; roomTypeId: string; roomName: string; boardCode: string; currency: string; occupancy: number
  contractCode: string; supplierName: string
  cells: CalendarCell[]
}
export interface HotelCalendar { hotelId: string; window: { from: string; to: string; days: number }; rows: CalendarRow[]; truncated: boolean }

export interface SellabilityInspectRequest { checkIn: string; checkOut: string; adults: number; children: number; rooms?: number; roomTypeId?: string }
export type NightVerdict = { date: string; sellable: boolean; reasons: string[]; rateMinor: string | null; remaining: number | null }
export interface SellabilityGateResult { key: string; label: string; state: 'PASS' | 'FAIL' | 'NA' }
export interface SellabilityPlanResult {
  ratePlanId: string; ratePlanCode: string; roomTypeId: string; roomName: string; boardCode: string; contractCode: string; supplierName: string
  sellable: boolean
  /** Stay-level canonical reasons (includes min/max stay, release days, closed-to-arrival). */
  reasons: string[]
  gates: SellabilityGateResult[]
  nights: NightVerdict[]
  /** Only present when the stay is sellable and every night has a SELL-basis rate. */
  totalMinor: string | null; currency: string
}
export interface SellabilityInspection {
  hotelId: string; hotelName: string
  request: { checkIn: string; checkOut: string; adults: number; children: number; rooms: number; nights: number; roomTypeId: string | null }
  sellable: boolean
  /** Hotel-level reasons that apply before any plan is considered. */
  hotelReasons: string[]
  offers: number
  cheapestMinor: string | null; currency: string | null
  plans: SellabilityPlanResult[]
  evaluatedAt: string
}

// ---- Exceptions centre -------------------------------------------------------------------------------------------
export interface ExceptionsQuery { severity?: IssueSeverity; category?: CommercialIssueCategory; supplierId?: string; hotelId?: string; from?: string; days?: number; page?: number; pageSize?: number }
export interface ExceptionsPage { items: CommercialIssue[]; page: number; pageSize: number; total: number; scanCapped: boolean; window: { from: string; to: string; days: number }; counts: Record<IssueSeverity, number> }

// ---- Distribution & readiness (ADR 0021, stage 6) ------------------------------------------------------------------
export interface DistributionBlocker {
  /** Canonical reason code (see COMMERCIAL_REASON_TEXT). */
  reason: string
  nights: number
  dates: string[]
  rooms: string[]
  ratePlans: string[]
  suppliers: string[]
}
export interface DistributionCoverageRow { label: string; planNights: number; sellable: number }

/**
 * Catalogue publication, distribution eligibility, transaction enablement and a seven-day coverage assessment, kept apart on purpose:
 * a published hotel is eligible for the catalogue, eligibility is not sellability, and neither enables booking or payment.
 * Everything is computed by the same evaluator Agent search uses; this view only reads.
 */
export interface HotelDistribution {
  generatedAt: string
  hotelId: string
  catalogue: {
    /** `Hotel.contentStatus`, the profile approval state. */
    status: string
    published: boolean
    suspended: boolean
    starRatingValid: boolean
    /** Published, not suspended, and with a 1-5 star rating: the hotel may appear in Agent search if something is sellable. Not a sellability verdict. */
    eligible: boolean
    reasons: string[]
  }
  transaction: {
    /** The platform booking switch. Publishing a hotel never changes it. */
    bookingEnabled: boolean
  }
  /** Agency distribution restrictions (ADR 0019) touching this hotel or its suppliers. null when the API database role cannot read them. */
  restrictions: { hotel: number; supplier: number } | null
  agentSellable: boolean
  coverage: {
    window: { from: string; to: string; days: number }
    planNights: number
    sellableNights: number
    byRoom: DistributionCoverageRow[]
    bySupplier: DistributionCoverageRow[]
    /** True when more rate plans exist than the assessment covers. */
    truncated: boolean
  }
  /** Why nights are not sellable, grouped by reason, with the dates, rooms, rate plans and suppliers affected. */
  blockers: DistributionBlocker[]
}
