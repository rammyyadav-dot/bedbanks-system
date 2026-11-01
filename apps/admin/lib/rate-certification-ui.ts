import type { CertificationStatus, HotelDistributionStatus, RateFindingSeverity, RateRowClass, RemediationPriority } from '@bedbanks/contracts'

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral'

/** Every status is conveyed by its word as well as its colour. */
export const certificationTone = (status: CertificationStatus): Tone => (status === 'PASS' ? 'ok' : status === 'WARN' ? 'warn' : 'bad')
export const hotelStatusTone = (status: HotelDistributionStatus): Tone => (status === 'CERTIFIED' ? 'ok' : status === 'READY_WITH_WARNINGS' ? 'warn' : 'bad')
export const hotelStatusText = (status: HotelDistributionStatus): string => status.split('_').join(' ')
export const severityTone = (severity: RateFindingSeverity): Tone => (severity === 'FAIL' ? 'bad' : severity === 'WARN' ? 'warn' : 'neutral')
export const priorityTone = (priority: RemediationPriority): Tone => (priority === 'P0' ? 'bad' : priority === 'P1' ? 'warn' : 'neutral')
export const rowClassTone = (rowClass: RateRowClass | null): Tone => (rowClass === 'VALID' ? 'ok' : rowClass === 'QUARANTINED' || rowClass === 'BLOCKED_NO_MARKUP' ? 'bad' : rowClass === null ? 'neutral' : 'warn')

export const ROW_CLASS_HELP: Record<RateRowClass, string> = {
  VALID: 'The evaluator can price a night from this row.',
  QUARANTINED: 'Zero amount, wrong currency or unverified basis: refused or untrustworthy until a person confirms it.',
  DEAD: 'Stored for an occupancy the plan does not use; search never reads it.',
  OUTSIDE_CONTRACT: 'Outside the contract validity dates; never sold.',
  BLOCKED_NO_MARKUP: 'A NET rate with no ACTIVE markup rule for that night; cannot be sold.',
}

export const WINDOW_OPTIONS = [30, 90, 180, 365] as const

/** Downloads text the browser already holds. Nothing is uploaded and no new request is made. */
export function downloadText(filename: string, mediaType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mediaType};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url; link.download = filename
  document.body.appendChild(link); link.click(); link.remove()
  URL.revokeObjectURL(url)
}

/** Basis points as a percentage with integer arithmetic only (1050 -> "10.50%"). */
export const percentText = (basisPoints: number): string => `${Math.trunc(basisPoints / 100)}.${String(basisPoints % 100).padStart(2, '0')}%`
