/**
 * Unified hotel readiness (`GET /admin/operations/hotels/:hotelId/readiness`).
 *
 * One assessment composes the existing authoritative validators into separate gates for ONE explicit set of criteria
 * (stay dates, per-room occupancy, guest nationality, agency and currency). It is not a universal availability claim:
 * a passing gate means "for these criteria, at evaluation time". Every commercial verdict is produced by the same evaluator
 * Agent search uses (`evaluateContractedStay`); this contract only carries the result.
 *
 * `UNKNOWN` means the evidence could not be read or does not exist (a privilege boundary, a missing record). It is never
 * collapsed into `FAIL`, zero or an empty list. `NOT_APPLICABLE` means the gate has nothing to judge for these criteria.
 */
export const READINESS_GATE_IDS = ['CONTENT', 'MAPPING', 'CONTRACT', 'RATE', 'INVENTORY', 'DISTRIBUTION', 'SEARCH_RECHECK_EVIDENCE'] as const
export type ReadinessGateId = (typeof READINESS_GATE_IDS)[number]
export type ReadinessGateOutcome = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE'

/** Hotel workspace tab that resolves a blocker (the same ids the Admin workspace routes use). */
export type ReadinessActionTab = 'setup' | 'rooms' | 'amenities' | 'images' | 'policies' | 'mappings' | 'contracts' | 'rates' | 'inventory' | 'sellability' | 'audit'
export interface ReadinessAction {
  tab: ReadinessActionTab
  label: string
  /** The existing permission needed to act there. The navigation target still enforces it; this only lets the UI explain a denial. */
  permission: string | null
}
export interface ReadinessEntityRef { type: 'HOTEL' | 'ROOM_TYPE' | 'RATE_PLAN' | 'CONTRACT' | 'SUPPLIER' | 'MAPPING' | 'AGENCY' | 'POOL'; id: string; label: string | null }
export interface ReadinessBlocker {
  /** Canonical reason code (see `COMMERCIAL_REASON_TEXT`) or a publication requirement key. */
  code: string
  message: string
  refs: ReadinessEntityRef[]
  /** Nights affected inside the stay, when the blocker is date specific. */
  nights: number | null
}
export interface ReadinessGateResult {
  gate: ReadinessGateId
  label: string
  outcome: ReadinessGateOutcome
  blockers: ReadinessBlocker[]
  /** Why the outcome is UNKNOWN or NOT_APPLICABLE; null otherwise. */
  reason: string | null
  /** Non-blocking context, for example that another rate plan has a problem the passing plan does not. */
  notes: string[]
  /** The criteria this gate actually evaluated, in plain words, so a PASS is never read as wider than it is. */
  criteriaApplied: string[]
  evaluatedAt: string
  /** Where to resolve it. Null for a PASS. */
  action: ReadinessAction | null
}

export interface HotelReadinessCriteria {
  checkIn: string; checkOut: string; nights: number
  rooms: number; adults: number; children: number; childAges: number[]
  /** ISO-3166 alpha-2 guest nationality, or null when not supplied (a contract that restricts nationality then fails closed). */
  nationality: string | null
  /** Buying agency. Null evaluates buyer-independently for distribution restrictions and market rules that need an agency. */
  agencyId: string | null
  /** Buyer market (the agency's country) used for contract sales-market rules. Null when no agency or the agency has no country. */
  market: string | null
  currency: string
}

export interface HotelReadinessAssessment {
  hotelId: string
  hotelName: string
  evaluatedAt: string
  criteria: HotelReadinessCriteria
  gates: ReadinessGateResult[]
  /** Judged over the six commercial gates only: FAIL if any fails, UNKNOWN if none fails but any is unknown, else PASS. */
  commercialVerdict: 'PASS' | 'FAIL' | 'UNKNOWN'
  /** Offers the shared evaluator would produce for these criteria. A prediction, never evidence that search or recheck ran. */
  predictedOffers: number
  /** What this assessment does not claim. Always shown next to a verdict. */
  scope: string
  limitations: string[]
}
