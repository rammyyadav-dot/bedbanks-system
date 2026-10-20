import { CONFIRMATION_CC_MAX, type CheckoutGuest, type DuplicateBookingMatch, type GuestTitle } from '@bedbanks/contracts/agent'

/** Same rule as the server and the lead guest: letters first, then letters, marks, apostrophes, spaces, dots and hyphens; 1-80 characters. */
const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,79}$/u
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export type GuestDraft = { key: string; roomNumber: number; type: 'ADULT' | 'CHILD'; title: GuestTitle | ''; firstName: string; lastName: string; age: number | null }

/** One row per guest for identical rooms: each room holds `adults` adults then one child per searched age. Room 1's first adult is the lead. */
export function buildRoster(rooms: number, adults: number, childAges: number[]): GuestDraft[] {
  const out: GuestDraft[] = []
  for (let room = 1; room <= rooms; room++) {
    for (let a = 0; a < adults; a++) out.push({ key: `r${room}a${a}`, roomNumber: room, type: 'ADULT', title: '', firstName: '', lastName: '', age: null })
    childAges.forEach((age, c) => out.push({ key: `r${room}c${c}`, roomNumber: room, type: 'CHILD', title: '', firstName: '', lastName: '', age }))
  }
  return out
}

export const isLead = (guest: GuestDraft, roster: GuestDraft[]) => roster.find((g) => g.roomNumber === 1 && g.type === 'ADULT')?.key === guest.key

/** Per-guest problems, keyed by guest key. Empty when every name is valid. */
export function rosterErrors(roster: GuestDraft[]): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const guest of roster) {
    const first = guest.firstName.trim(); const last = guest.lastName.trim()
    if (!first || !last) errors[guest.key] = 'Enter the first and last name.'
    else if (!NAME.test(first) || !NAME.test(last)) errors[guest.key] = 'Use letters only (up to 80 characters each).'
  }
  return errors
}

export function rosterPayload(roster: GuestDraft[]): CheckoutGuest[] {
  return roster.map((g) => ({ roomNumber: g.roomNumber, type: g.type, ...(g.title ? { title: g.title } : {}), firstName: g.firstName.trim(), lastName: g.lastName.trim(), ...(g.type === 'CHILD' && g.age !== null ? { age: g.age } : {}) }))
}

/** "a@x.com, b@y.com" -> up to three valid, de-duplicated addresses, never the agent's own. */
export function parseCcEmails(input: string, own: string | null): { ok: true; emails: string[] } | { ok: false; reason: string } {
  const emails: string[] = []
  for (const part of input.split(/[,;\s]+/)) {
    const email = part.trim().toLowerCase()
    if (!email) continue
    if (email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: `"${part.trim()}" is not a valid email address.` }
    if (email !== own?.toLowerCase() && !emails.includes(email)) emails.push(email)
  }
  if (emails.length > CONFIRMATION_CC_MAX) return { ok: false, reason: `Add at most ${CONFIRMATION_CC_MAX} CC addresses.` }
  return { ok: true, emails }
}

/** Whole nights between two ISO dates (UTC days), or null when either date is unreadable or the range is empty. */
export function stayNights(checkIn: string, checkOut: string): number | null {
  const start = Date.parse(`${checkIn}T00:00:00Z`); const end = Date.parse(`${checkOut}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return Math.round((end - start) / 86_400_000)
}

/** Estimated-arrival choices in hotel local time, every 30 minutes, "HH:MM". */
export const ARRIVAL_TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`)

/** The existing bookings a DUPLICATE_BOOKING_SUSPECTED refusal names. Anything malformed is dropped rather than shown. */
export function duplicateMatches(details: unknown): DuplicateBookingMatch[] {
  if (!Array.isArray(details)) return []
  return details.filter((d): d is DuplicateBookingMatch => typeof d === 'object' && d !== null && typeof (d as DuplicateBookingMatch).reference === 'string'
    && typeof (d as DuplicateBookingMatch).status === 'string' && typeof (d as DuplicateBookingMatch).createdAt === 'string').slice(0, 3)
}
