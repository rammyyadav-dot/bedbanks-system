/**
 * Rate plan audit and distribution certification contracts (ADR 0033).
 *
 * Everything here is a read-only diagnosis of data the single contracted-stay evaluator already prices. Nothing is repaired, merged, deleted
 * or published by these routes, and a certification is an observation at `generatedAt`, not a flag the Agent search reads.
 * Money is integer minor units as decimal strings plus an ISO-4217 currency.
 */

export const CERTIFICATION_STATUSES = ['PASS', 'WARN', 'FAIL'] as const;
export type CertificationStatus = (typeof CERTIFICATION_STATUSES)[number];

export const HOTEL_DISTRIBUTION_STATUSES = ['NOT_READY', 'READY_WITH_WARNINGS', 'CERTIFIED'] as const;
export type HotelDistributionStatus = (typeof HOTEL_DISTRIBUTION_STATUSES)[number];

export const REMEDIATION_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type RemediationPriority = (typeof REMEDIATION_PRIORITIES)[number];

export type RateFindingSeverity = 'FAIL' | 'WARN' | 'INFO';

/** Stable finding codes. A code never changes meaning; new checks add new codes. */
export const RATE_FINDING_CODES = [
  // FAIL: a priced night would be wrong, refused, or ambiguous
  'RATE_AMOUNT_ZERO', 'RATE_CURRENCY_MISMATCH', 'RATE_BASIS_UNVERIFIED', 'NET_MARKUP_MISSING',
  'PLAN_CURRENCY_NOT_ENABLED', 'PLAN_CONTRACT_CURRENCY_MISMATCH', 'OCCUPANCY_EXCEEDS_ROOM', 'PLAN_CONTRACT_NOT_ACTIVE',
  'NO_PRICED_NIGHTS', 'DUPLICATE_PLAN_CODE', 'DUPLICATE_LOGICAL_PLAN',
  // WARN: sells today, but hygiene or coverage needs a person
  'RATE_GAPS', 'RATE_MIXED_BASIS', 'RATE_OUTSIDE_CONTRACT', 'RATE_OTHER_OCCUPANCY', 'AVAILABILITY_GAPS', 'NO_SELLABLE_NIGHTS',
  'PLAN_CODE_FORMAT', 'CONTRACT_EXPIRING', 'SALES_MARKETS_NOT_ENFORCED', 'MARKUP_ZERO_PERCENT', 'MARKUP_VERY_HIGH',
  // INFO
  'PLAN_NOT_LIVE',
] as const;
export type RateFindingCode = (typeof RATE_FINDING_CODES)[number];

export interface RateFinding {
  code: RateFindingCode;
  severity: RateFindingSeverity;
  message: string;
  /** Rows or nights affected. 1 for plan-level findings. */
  count: number;
  /** Up to five affected dates (YYYY-MM-DD) or ids, for orientation only. */
  sample: string[];
}

/**
 * Row classes for the loaded DailyRate rows of a plan. The class of a row is the first that applies, in this order.
 * Duplicate (plan, date, occupancy) keys are impossible: the table has a unique key, so there is no AMBIGUOUS class.
 */
export const RATE_ROW_CLASSES = ['VALID', 'QUARANTINED', 'DEAD', 'OUTSIDE_CONTRACT', 'BLOCKED_NO_MARKUP'] as const;
export type RateRowClass = (typeof RATE_ROW_CLASSES)[number];
export type RateRowClassCounts = Record<RateRowClass, number>;

export interface RatePlanAuditRow {
  ratePlanId: string;
  code: string;
  hotelId: string;
  hotelName: string;
  roomName: string;
  boardCode: string;
  contractCode: string;
  supplierName: string;
  planStatus: string;
  contractStatus: string;
  occupancy: number;
  currency: string;
  /** False for a plan that is not ACTIVE: reported, never certified or failed. */
  live: boolean;
  status: CertificationStatus;
  nights: number;
  sellableNights: number;
  rowClasses: RateRowClassCounts;
  amountBasis: 'SELL' | 'NET' | 'UNVERIFIED' | 'MIXED' | 'NONE';
  findings: RateFinding[];
  /** A code that satisfies the governance pattern, offered for an administrator to confirm. Never applied automatically. */
  suggestedCode: string | null;
}

export interface HotelCertification {
  hotelId: string;
  hotelName: string;
  city: string;
  status: HotelDistributionStatus;
  blockers: string[];
  warnings: string[];
  plans: { total: number; live: number; pass: number; warn: number; fail: number };
  sellableNights: number;
  totalNights: number;
}

export interface RateCertificationSummary {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  scanCapped: boolean;
  totals: { hotels: number; plans: number; livePlans: number };
  plans: Record<CertificationStatus, number>;
  hotels: Record<HotelDistributionStatus, number>;
  rowClasses: RateRowClassCounts;
  findings: Array<{ code: RateFindingCode; severity: RateFindingSeverity; plans: number; count: number }>;
  remediation: Record<RemediationPriority, number>;
  markup: { activeRules: number; findings: number };
}

export interface RateCertificationPlansPage {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  scanCapped: boolean;
  items: RatePlanAuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RatePlanAuditDetail extends RatePlanAuditRow {
  window: { from: string; to: string; days: number };
  generatedAt: string;
  /** One entry per date of the window with the evaluator's own verdict for a one-night stay at the plan occupancy. */
  calendar: Array<{ date: string; rateMinor: string | null; basis: 'NET' | 'SELL' | null; rowClass: RateRowClass | null; sellable: boolean; reasons: string[] }>;
  contract: { validFrom: string; validTo: string; settlementCurrency: string; salesMarkets: string[]; nationalities: string[] };
}

export interface HotelCertificationPage {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  scanCapped: boolean;
  items: HotelCertification[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MarkupRuleAuditRow {
  id: string;
  scope: 'TENANT_DEFAULT' | 'SUPPLIER' | 'HOTEL';
  supplierId: string | null;
  hotelId: string | null;
  basisPoints: number;
  validFrom: string;
  validTo: string | null;
  status: string;
  findings: RateFinding[];
}

export interface MarkupRuleAudit {
  generatedAt: string;
  rules: MarkupRuleAuditRow[];
  counts: { total: number; active: number; draft: number; retired: number; other: number };
  /** NET plans with at least one night where no ACTIVE rule applies. */
  netPlansWithoutMarkup: number;
}

export interface RemediationItem {
  /** Deterministic: `${ratePlanId or hotelId}|${code}`. */
  id: string;
  priority: RemediationPriority;
  hotelId: string;
  hotelName: string;
  ratePlanId: string | null;
  ratePlanCode: string | null;
  code: RateFindingCode;
  severity: RateFindingSeverity;
  message: string;
  count: number;
  /** Plain-language next step for a person. Nothing here is executable. */
  suggestedAction: string;
}

export interface RemediationQueue {
  generatedAt: string;
  scanCapped: boolean;
  counts: Record<RemediationPriority, number>;
  items: RemediationItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ---- price simulator (read-only) -----------------------------------------------------------------------------------------
export interface SimulateRequest {
  ratePlanId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  rooms?: number;
}

export interface SimulatedNight {
  date: string;
  /** Stored amount in minor units, and what it means. */
  rateMinor: string | null;
  basis: 'NET' | 'SELL' | null;
  markupBasisPoints: number | null;
  markupMinor: string | null;
  sellMinor: string | null;
}

export interface SimulationResult {
  ratePlanId: string;
  ratePlanCode: string;
  hotelId: string;
  currency: string;
  eligible: boolean;
  reasons: string[];
  nights: SimulatedNight[];
  /** Per room, from the evaluator. Null when not eligible. */
  netMinor: string | null;
  markupMinor: string | null;
  totalMinor: string | null;
  /** Sum of the per-night sells above, per room. Independent of the evaluator. */
  recomputedTotalMinor: string | null;
  /** True when the evaluator total equals the independent per-night recomputation, or the stay is not eligible. */
  reconciles: boolean;
  rooms: number;
  generatedAt: string;
}

export interface RateCertificationReport {
  filename: string;
  mediaType: 'application/json' | 'text/markdown';
  generatedAt: string;
  content: string;
}

/** Concepts that appear in other bedbank pricing specs but do not exist in fBeds. Reported as not applicable, never as passed. */
export const RATE_CERTIFICATION_NOT_APPLICABLE: ReadonlyArray<{ concept: string; reason: string }> = [
  { concept: 'Pricing layers and promotions', reason: 'fBeds has one contracted rate and one markup rule per night; there is no layer or promotion engine.' },
  { concept: 'Agent extra markup', reason: 'Markup is a tenant, supplier or hotel rule (ADR 0018); agencies have no private markup.' },
  { concept: 'Event supplements', reason: 'No supplement model exists.' },
  { concept: 'SGL / DBL / TPL occupancy columns', reason: 'A rate plan prices one numeric occupancy; there are no per-type columns.' },
  { concept: 'Meal Plan Master', reason: 'Board basis is a small reference table already checked by the evaluator.' },
  { concept: 'Bulk Rate Loader', reason: 'Rates are authored through Quick Update and supply routes; there is no bulk loader to audit.' },
  { concept: 'Whole-AED rounding', reason: 'Prices stay in exact minor units; the half-up markup rounding is in @bedbanks/pricing.' },
  { concept: 'Source-market pricing', reason: 'Contract sales markets and nationalities are recorded but not applied by search (reported as a warning).' },
];

/**
 * scanCap is the most hotels one request loads; maxPlanNights bounds the audit work (live plans x nights, about 0.2 ms each, so roughly 12 s at the limit).
 * Responses say when either was reached.
 */
export const RATE_CERTIFICATION_LIMITS = { defaultDays: 90, maxDays: 365, scanCap: 200, maxPlanNights: 60_000, pageSize: 25, maxPageSize: 100, maxSimulateNights: 31 } as const;
