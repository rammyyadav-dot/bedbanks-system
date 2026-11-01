import { applyPercentMarkup } from '@bedbanks/pricing'
import type { Money } from '@bedbanks/money'

/**
 * Client markup (ADR 0065): a display-only percentage the agent adds for their own client. Held in integer basis points
 * (1% = 100 bp); never sent with a search, recheck, hold or booking.
 */
export const MAX_CLIENT_MARKUP_BP = 5_000
export const CLIENT_MARKUP_STEP_BP = 100

/** "10", "12.5" or "12.25" (at most two decimals) -> basis points, by string arithmetic. Empty is 0. */
export function parseMarkupPercent(input: string): { ok: true; basisPoints: number } | { ok: false; reason: string } {
  const text = input.trim()
  if (text === '') return { ok: true, basisPoints: 0 }
  const match = text.match(/^(\d{1,2})(?:\.(\d{1,2}))?$/)
  if (!match) return { ok: false, reason: 'Enter a markup from 0 to 50%, with at most two decimals.' }
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  if (basisPoints > MAX_CLIENT_MARKUP_BP) return { ok: false, reason: 'The markup can be at most 50%.' }
  return { ok: true, basisPoints }
}

/** Basis points -> the shortest percent text ("1250" -> "12.5"). */
export function formatMarkupPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100)
  const fraction = String(basisPoints % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

export function stepMarkup(basisPoints: number, direction: 1 | -1): number {
  const next = basisPoints + direction * CLIENT_MARKUP_STEP_BP
  return Math.min(MAX_CLIENT_MARKUP_BP, Math.max(0, next))
}

/** The client price for a total, or null when there is no markup or the amount cannot be represented. */
export function clientPrice(total: Money, basisPoints: number): Money | null {
  if (!Number.isSafeInteger(basisPoints) || basisPoints <= 0 || basisPoints > MAX_CLIENT_MARKUP_BP) return null
  if (!Number.isSafeInteger(total.amountMinor) || total.amountMinor < 0) return null
  try { return applyPercentMarkup(total, basisPoints) } catch { return null }
}

const storageKey = (userId: string, tenantId: string) => `fbeds:agent:client-markup:${tenantId}:${userId}`

export function readClientMarkup(storage: Pick<Storage, 'getItem'> | undefined, userId: string, tenantId: string): number {
  try {
    const raw = storage?.getItem(storageKey(userId, tenantId))
    const value = raw === null || raw === undefined ? 0 : Number(raw)
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CLIENT_MARKUP_BP ? value : 0
  } catch { return 0 }
}

export function rememberClientMarkup(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, userId: string, tenantId: string, basisPoints: number): void {
  try {
    if (basisPoints > 0) storage?.setItem(storageKey(userId, tenantId), String(basisPoints))
    else storage?.removeItem(storageKey(userId, tenantId))
  } catch { /* storage unavailable: the markup still applies for this page */ }
}
