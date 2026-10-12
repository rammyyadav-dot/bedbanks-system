import type { ExtranetNetStatus } from '@bedbanks/contracts'

export interface NetSummary { netStatus: ExtranetNetStatus; netMinor: string | null }

/**
 * Supplier-facing net of a booking, computed from room lines only (ADR 0061 Amendment 1, CTO decision 1).
 * The booking-level `net_minor` is never shown on its own: it can only veto an aggregate that does not reconcile with it.
 * Integer arithmetic on bigint; no floating point. A negative or missing line is never treated as zero.
 */
export function summariseNet(lines: readonly (bigint | null)[], bookingNet: bigint | null): NetSummary {
  const recorded = lines.filter((value): value is bigint => value !== null)
  if (lines.length === 0 || recorded.length === 0) return { netStatus: 'NOT_RECORDED', netMinor: null }
  if (recorded.length !== lines.length) return { netStatus: 'PARTIAL', netMinor: null }
  if (recorded.some((value) => value < 0n)) return { netStatus: 'MISMATCH', netMinor: null }
  const sum = recorded.reduce((total, value) => total + value, 0n)
  if (bookingNet !== null && bookingNet !== sum) return { netStatus: 'MISMATCH', netMinor: null }
  return { netStatus: 'RECORDED', netMinor: sum.toString() }
}
