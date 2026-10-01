import type { SellabilityResult } from '@bedbanks/contracts'

/**
 * Presentation grouping of the backend's stable sellability reason codes.
 * The API is the only source of truth: a check shows FAIL only when the API returned one of its codes,
 * and any code not listed here is surfaced verbatim under "Other" rather than guessed at or hidden.
 */
export const SELLABILITY_CHECKS: ReadonlyArray<{ label: string; codes: readonly string[] }> = [
  { label: 'Hotel', codes: ['HOTEL_INACTIVE'] },
  { label: 'Room', codes: ['ROOM_TYPE_INACTIVE'] },
  { label: 'Board Basis', codes: ['BOARD_BASIS_INACTIVE'] },
  { label: 'Hotel Mapping', codes: ['SUPPLIER_MAPPING_INVALID'] },
  { label: 'Room Mapping', codes: ['ROOM_MAPPING_UNAPPROVED'] },
  { label: 'Supplier', codes: ['SUPPLIER_INACTIVE'] },
  { label: 'Contract', codes: ['CONTRACT_INACTIVE', 'OUTSIDE_CONTRACT_VALIDITY'] },
  { label: 'Rate Plan', codes: ['RATE_PLAN_MISSING', 'RATE_PLAN_INACTIVE'] },
  { label: 'Daily Rates', codes: ['DAILY_RATE_MISSING_OR_INVALID', 'RATE_CURRENCY_MISMATCH', 'RATE_AMOUNT_BASIS_UNVERIFIED', 'NET_RATE_MARKUP_UNAVAILABLE'] },
  { label: 'Availability', codes: ['AVAILABILITY_MISSING', 'NO_INVENTORY'] },
  { label: 'Stop Sell', codes: ['STOP_SELL'] },
  { label: 'Occupancy', codes: ['OCCUPANCY_UNSUPPORTED'] },
  { label: 'Minimum / Maximum Stay', codes: ['MIN_STAY_NOT_MET', 'MAX_STAY_EXCEEDED'] },
  { label: 'Release Days', codes: ['RELEASE_WINDOW_VIOLATED'] },
]

export interface NightResult { stayDate: string; result: SellabilityResult }
export interface CheckSummary { label: string; status: 'PASS' | 'FAIL'; findings: Array<{ stayDate: string; code: string }> }
export interface SellabilitySummary { sellable: boolean; checks: CheckSummary[]; failures: Array<{ stayDate: string; code: string }> }

export function summarizeSellability(nights: NightResult[]): SellabilitySummary {
  const failures = nights.flatMap(({ stayDate, result }) => result.reasons.map((code) => ({ stayDate, code })))
  const known = new Set(SELLABILITY_CHECKS.flatMap((check) => check.codes))
  const checks: CheckSummary[] = SELLABILITY_CHECKS.map((check) => {
    const findings = failures.filter((failure) => check.codes.includes(failure.code))
    return { label: check.label, status: findings.length ? 'FAIL' : 'PASS', findings }
  })
  const other = failures.filter((failure) => !known.has(failure.code))
  if (other.length) checks.push({ label: 'Other', status: 'FAIL', findings: other })
  return { sellable: nights.length > 0 && nights.every(({ result }) => result.eligible), checks, failures }
}
