const CURRENCY = /^[A-Z]{3}$/
const INTEGER = /^-?\d+$/

/**
 * Formats an integer minor-unit amount in its own currency, e.g. 125000 USD -> "USD 1,250.00".
 * BigInt arithmetic only: no floating point is used on money. Returns null for anything
 * that is not a safe integer amount with an ISO-4217 code, so callers never guess a value.
 */
export function formatMinorAmount(amountMinor: string | number | bigint | null | undefined, currency: string | null | undefined): string | null {
  if (amountMinor === null || amountMinor === undefined || !currency || !CURRENCY.test(currency)) return null
  let amount: bigint
  if (typeof amountMinor === 'bigint') amount = amountMinor
  else if (typeof amountMinor === 'number') {
    if (!Number.isSafeInteger(amountMinor)) return null
    amount = BigInt(amountMinor)
  } else {
    if (!INTEGER.test(amountMinor)) return null
    amount = BigInt(amountMinor)
  }
  let digits = 2
  try { digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 } catch { return null }
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const scale = 10n ** BigInt(digits)
  const whole = new Intl.NumberFormat('en-US').format(absolute / scale)
  const fraction = digits > 0 ? `.${String(absolute % scale).padStart(digits, '0')}` : ''
  return `${currency} ${negative ? '-' : ''}${whole}${fraction}`
}

const DAY = 86_400_000
function parseDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(time)
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? time : null
}

/** "2026-11-20" + "2026-11-23" -> "20 Nov – 23 Nov 2026 · 3 nights". Falls back to the raw values. */
export function formatStay(checkIn: string, checkOut: string): string {
  const start = parseDate(checkIn)
  const end = parseDate(checkOut)
  if (start === null || end === null || end <= start) return `${checkIn} – ${checkOut}`
  const short = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const full = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  const nights = Math.round((end - start) / DAY)
  const sameYear = new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear()
  return `${sameYear ? short.format(start) : full.format(start)} – ${full.format(end)} · ${nights} night${nights === 1 ? '' : 's'}`
}

/** "12–15 Oct" when the stay is inside one month, otherwise "30 Dec – 2 Jan". */
export function formatCompactStay(checkIn: string, checkOut: string): string {
  const start = parseDate(checkIn)
  const end = parseDate(checkOut)
  if (start === null || end === null || end <= start) return `${checkIn} – ${checkOut}`
  const startDate = new Date(start)
  const endDate = new Date(end)
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'UTC' })
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
  if (startDate.getUTCFullYear() === endDate.getUTCFullYear() && startDate.getUTCMonth() === endDate.getUTCMonth()) {
    return `${day.format(start)}–${day.format(end)} ${month.format(end)}`
  }
  const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${dayMonth.format(start)} – ${dayMonth.format(end)}`
}

/** Formats an absolute cancellation instant in the property timezone without changing the source timestamp. */
export function formatCancellationDeadline(iso: string, timeZone: string): string | null {
  const time = Date.parse(iso)
  if (!Number.isFinite(time) || !timeZone) return null
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone, hourCycle: 'h23' }).formatToParts(new Date(time))
    const value = (type: string) => parts.find((part) => part.type === type)?.value
    const hour = value('hour')
    const minute = value('minute')
    const day = value('day')
    const month = value('month')
    if (!hour || !minute || !day || !month) return null
    return `${hour}:${minute} on ${day} ${month}`
  } catch {
    return null
  }
}

export function weekdayShort(value: string): string | null {
  const time = parseDate(value)
  if (time === null) return null
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(time)
}

/** Signed difference of two minor-unit amounts. Positive values keep a leading plus. */
export function formatMinorDelta(previousMinor: number, nextMinor: number, currency: string): string | null {
  if (!Number.isSafeInteger(previousMinor) || !Number.isSafeInteger(nextMinor)) return null
  const delta = BigInt(nextMinor) - BigInt(previousMinor)
  const formatted = formatMinorAmount(delta, currency)
  if (!formatted || delta <= 0n) return formatted
  return `+${formatted}`
}

export type CreditSummary = { currency?: string | null; availableCredit?: string | number | null; creditLimit?: string | number | null }

/** Available credit, credit limit and credit used (limit - available) in the wallet currency. Null entries are unknown, never guessed. */
export function creditBreakdown(summary: CreditSummary | null | undefined): { available: string | null; limit: string | null; used: string | null } {
  const toBig = (value: string | number | null | undefined): bigint | null => {
    if (value === null || value === undefined) return null
    try { return typeof value === 'number' ? (Number.isSafeInteger(value) ? BigInt(value) : null) : (INTEGER.test(value) ? BigInt(value) : null) } catch { return null }
  }
  const available = toBig(summary?.availableCredit)
  const limit = toBig(summary?.creditLimit)
  const currency = summary?.currency
  return {
    available: available === null ? null : formatMinorAmount(available, currency),
    limit: limit === null ? null : formatMinorAmount(limit, currency),
    used: available === null || limit === null ? null : formatMinorAmount(limit - available, currency),
  }
}
