export type FinancePhase = 'loading' | 'ready' | 'denied' | 'unavailable' | 'stale'

export type FinanceView<T> = { phase: FinancePhase; summary: T | null }

/** A failed refresh never leaves the previous balance labelled as current. */
export function nextFinanceView<T>(current: FinanceView<T>, outcome: { ok: true; summary: T } | { ok: false; denied: boolean }): FinanceView<T> {
  if (outcome.ok) return { phase: 'ready', summary: outcome.summary }
  if (outcome.denied) return { phase: 'denied', summary: null }
  if (current.phase === 'ready' || current.phase === 'stale') return { phase: 'stale', summary: null }
  return { phase: 'unavailable', summary: null }
}

export function financeCreditLabel(phase: FinancePhase, formatted: string | null): string {
  if (phase === 'loading') return 'Checking credit…'
  if (phase === 'denied') return 'Not included in your access'
  if (phase === 'ready') return formatted ?? 'Not configured'
  if (phase === 'stale') return 'Balance unavailable'
  return 'Not configured'
}
