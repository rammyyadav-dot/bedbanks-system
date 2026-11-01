import { assertHotelbedsBookBody, hotelbedsAedMinor, SandboxError, type HotelbedsBookBody, type HotelbedsBookPax } from './hotelbeds-sandbox'

/** Supplier-neutral shapes the booking adapter maps to. Provider wire types stay in this file (CLAUDE.md invariant 9). */
export interface HotelbedsBookingGuest { type: 'AD' | 'CH'; age?: number; name: string; surname: string }
export interface HotelbedsBookingInputs {
  rateKey: string
  holder: { name: string; surname: string }
  guests: HotelbedsBookingGuest[]
}
export type HotelbedsBookingState = 'CONFIRMED' | 'CANCELLED'
export interface HotelbedsBookingFacts {
  state: HotelbedsBookingState
  supplierRef: string
  clientReference: string
  /** Supplier net in AED minor units. Absent from a list entry, so null there. */
  totalNetMinor: number | null
}
function fail(code: 'malformed_response' | 'unsupported'): never { throw new SandboxError(code) }

const REFERENCE = /^FB-([0-9A-F]{20})$/
/** Hotelbeds limits the client reference to 20 characters; ours is `FB-` plus 20 hex digits, so the suffix is a lossless, deterministic key. */
export function hotelbedsClientReference(reference: string): string {
  const match = REFERENCE.exec(reference)
  if (!match) fail('unsupported')
  return match[1]
}

export function buildHotelbedsBookBody(reference: string, inputs: HotelbedsBookingInputs): HotelbedsBookBody {
  const paxes: HotelbedsBookPax[] = inputs.guests.map(g => ({ roomId: 1, type: g.type, ...(g.type === 'CH' ? { age: g.age } : {}), name: g.name, surname: g.surname }))
  const body: HotelbedsBookBody = { holder: { name: inputs.holder.name, surname: inputs.holder.surname }, rooms: [{ rateKey: inputs.rateKey, paxes }], clientReference: hotelbedsClientReference(reference), tolerance: 0 }
  assertHotelbedsBookBody(body) // refused here, before any supplier call; the transport checks again
  return body
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed_response')
  return value as Record<string, unknown>
}
function booking(raw: unknown, withTotal: boolean): HotelbedsBookingFacts {
  const b = object(raw)
  const status = b.status
  if (status !== 'CONFIRMED' && status !== 'CANCELLED') fail('malformed_response')
  if (typeof b.reference !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(b.reference)) fail('malformed_response')
  if (typeof b.clientReference !== 'string' || !/^[A-Z0-9]{1,20}$/.test(b.clientReference)) fail('malformed_response')
  // A cancelled booking can carry a zero total or cancellation charges, so the amount is only read where it is required to be a real price.
  const totalNetMinor = withTotal && status === 'CONFIRMED' ? hotelbedsAedMinor(b.totalNet) : null
  if (withTotal && status === 'CONFIRMED' && b.currency !== 'AED') fail('malformed_response')
  return { state: status, supplierRef: b.reference, clientReference: b.clientReference, totalNetMinor }
}

/** Response of POST /bookings (and DELETE /bookings/{ref}): `{ booking: {...} }`. */
export function normalizeHotelbedsBooking(payload: unknown): HotelbedsBookingFacts {
  return booking(object(payload).booking, true)
}

/** Response of GET /bookings: `{ bookings: { bookings: [...] } }`. Returns the entry for our client reference, or null when the supplier holds none. */
export function findHotelbedsBooking(payload: unknown, clientReference: string): HotelbedsBookingFacts | null {
  const wrapper = object(object(payload).bookings)
  const list = wrapper.bookings === undefined ? [] : wrapper.bookings
  if (!Array.isArray(list) || list.length > 25) fail('malformed_response')
  const matches = list.map(raw => booking(raw, false)).filter(b => b.clientReference === clientReference)
  if (matches.length > 1) fail('malformed_response') // two supplier bookings under one of our references is never silently resolved
  return matches[0] ?? null
}
