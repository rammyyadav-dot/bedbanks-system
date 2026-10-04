/**
 * Hotel-local wall-clock helpers for the inventory release rule. Pure and dependency-free (Intl only).
 * DST rule: a local time that does not exist (spring-forward gap) resolves to the LATER instant; a local time that
 * occurs twice (fall-back overlap) resolves to the EARLIER instant. Both choices are the stricter reading of a cut-off.
 */

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true } catch { return false }
}

export function isValidReleaseTime(value: string): boolean { return HHMM.test(value) }

/** Offset of the zone from UTC at an instant, in milliseconds (positive east of UTC). */
function offsetMs(instantMs: number, timeZone: string): number {
  const p: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instantMs / 1000) * 1000
}

/** The UTC instant at which the hotel's wall clock reads `day` `time` (YYYY-MM-DD, HH:mm). Throws on invalid input. */
export function zonedLocalToUtc(day: string, time: string, timeZone: string): Date {
  if (!DAY.test(day) || !HHMM.test(time) || !isValidTimeZone(timeZone)) throw new RangeError('invalid zoned time input')
  const [y, mo, d] = day.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0)
  if (new Date(wallAsUtc).getUTCDate() !== d) throw new RangeError('invalid calendar day')
  const before = offsetMs(wallAsUtc - 86_400_000, timeZone)
  const after = offsetMs(wallAsUtc + 86_400_000, timeZone)
  const candidates = [...new Set([wallAsUtc - before, wallAsUtc - after])]
  const valid = candidates.filter((c) => offsetMs(c, timeZone) === wallAsUtc - c)
  if (valid.length > 0) return new Date(Math.min(...valid)) // overlap: earlier
  return new Date(Math.max(...candidates)) // gap: later
}

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000).toISOString().slice(0, 10)
}

/** Instant after which a plan stops selling a check-in: `releaseDays` hotel-local days before check-in at `releaseTimeLocal`. */
export function releaseDeadline(checkIn: string, releaseDays: number, releaseTimeLocal: string, timeZone: string): Date {
  return zonedLocalToUtc(addDays(checkIn, -releaseDays), releaseTimeLocal, timeZone)
}

/** Sellable iff strictly before the deadline. An unusable zone or time fails closed (not sellable). */
export function releaseAllows(now: Date, checkIn: string, releaseDays: number, releaseTimeLocal: string, timeZone: string): boolean {
  try { return now.getTime() < releaseDeadline(checkIn, releaseDays, releaseTimeLocal, timeZone).getTime() } catch { return false }
}
