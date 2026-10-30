export type HotelNoticeRecipient = { ok: true; address: string } | { ok: false; code: 'NO_RESERVATIONS_EMAIL' }

/** One mailbox: no whitespace, no list separators, no angle brackets, no control characters (header injection), a dotted domain, at most 254 characters. */
const SINGLE_ADDRESS = /^[^\s@<>,;:"()[\]\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/**
 * Who a hotel's reservation notice goes to (ADR 0106): the email filled in on the hotel profile under `contacts.reservations`, and nothing else. The commercial,
 * finance and emergency contacts are never a fallback: a mailbox that was not given for reservations must not receive guest names. Anything that is not exactly one
 * valid address fails closed, so the caller records a visible FAILED notice instead of guessing. Pure; `contacts` is the stored JSON, which is untrusted shape.
 */
export function resolveHotelNoticeRecipient(contacts: unknown): HotelNoticeRecipient {
  const reservations = contacts && typeof contacts === 'object' && !Array.isArray(contacts) ? (contacts as Record<string, unknown>).reservations : undefined
  const email = reservations && typeof reservations === 'object' && !Array.isArray(reservations) ? (reservations as Record<string, unknown>).email : undefined
  if (typeof email !== 'string') return { ok: false, code: 'NO_RESERVATIONS_EMAIL' }
  const address = email.trim()
  return address.length <= 254 && SINGLE_ADDRESS.test(address) ? { ok: true, address } : { ok: false, code: 'NO_RESERVATIONS_EMAIL' }
}

export const MAX_NOTICE_COPIES = 3

/**
 * Who gets a blind copy of a hotel notice (ADR 0106): the booking agent and the admin mailbox. Each must be exactly one valid address; duplicates (case-insensitive) and the
 * hotel's own address are dropped, and at most three are kept. The hotel's address is excluded so a copy is never also the primary recipient. Pure.
 */
export function normalizeCopyAddresses(candidates: ReadonlyArray<string | null | undefined>, hotelAddress: string | null): string[] {
  const seen = new Set<string>(hotelAddress ? [hotelAddress.toLowerCase()] : [])
  const out: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const address = candidate.trim()
    if (address.length > 254 || !SINGLE_ADDRESS.test(address) || seen.has(address.toLowerCase())) continue
    seen.add(address.toLowerCase())
    out.push(address)
    if (out.length === MAX_NOTICE_COPIES) break
  }
  return out
}
