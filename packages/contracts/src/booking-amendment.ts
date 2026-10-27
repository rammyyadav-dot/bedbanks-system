/**
 * Booking amendments (ADR 0072). Pure and transport-agnostic: no Nest, no Prisma, no clock (callers pass `today`).
 *
 * An amendment changes a Confirmed booking's stay dates and/or the occupancy of its rooms. Because either changes the price, approving one needs the price the supplier
 * confirmed: there is no live supplier or rate engine behind the Admin, so a person records it, and the system does the arithmetic (integer minor units, signed
 * difference), applies everything in one transaction and records the money fact. A change of guest names or special requests is not structured: it carries no price, goes to
 * the supplier directly (spec workflow E) and stays a free-text request.
 *
 * Nothing here contains guest personal data: a proposal is dates and head counts only.
 */
import type { MinorString } from './operations'

export const BOOKING_AMENDMENT_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED'] as const
export type BookingAmendmentStatus = (typeof BOOKING_AMENDMENT_STATUSES)[number]

export const BOOKING_AMENDMENT_LIMITS = { maxNights: 60, maxAdults: 9, maxChildren: 6, maxChildAge: 17, maxRooms: 8, minorDigits: 15 } as const

export interface AmendmentRoomChange { position: number; adults: number; children: number; childAges: number[] }
/** What the requester wants to change. At least one of the two parts, and at least one real difference from the booking. */
export interface BookingAmendmentProposal { checkIn?: string; checkOut?: string; rooms?: AmendmentRoomChange[] }
/** What the approver records: the price the supplier confirmed, and optionally the new net and the new free-cancellation deadline. */
export interface BookingAmendmentApproval {
  /** The new total sell, integer minor units in the booking's currency. */
  sellMinor: MinorString
  /** The new total net. Omitted: the net becomes unknown (null), never carried over as a stale number. */
  netMinor?: MinorString | null
  /** UTC ISO instant. Omitted when the stay dates changed: the deadline becomes unknown (null). Omitted when they did not: unchanged. */
  cancelDeadline?: string | null
}

/** The booking's current state, as far as an amendment cares. */
export interface AmendmentSubject {
  checkIn: string | null
  checkOut: string | null
  rooms: Array<{ position: number; adults: number; children: number; childAges: number[] }>
}
export interface AmendmentState extends AmendmentSubject { nights: number | null; sellMinor: MinorString; netMinor: MinorString | null; cancelDeadline: string | null }

export interface AmendmentIssue { field: string; message: string }
export type AmendmentValidation = { ok: true; proposal: BookingAmendmentProposal; stay: { checkIn: string | null; checkOut: string | null; nights: number | null }; changes: AmendmentChange[] } | { ok: false; issues: AmendmentIssue[] }
export type AmendmentChange = 'STAY_DATES' | 'OCCUPANCY'

export const BOOKING_AMENDMENT_FAILURE = {
  invalid: 'AMENDMENT_INVALID',
  noChange: 'AMENDMENT_NO_CHANGE',
  approvalRequired: 'AMENDMENT_APPROVAL_REQUIRED',
  approvalInvalid: 'AMENDMENT_APPROVAL_INVALID',
  approvalNotExpected: 'AMENDMENT_APPROVAL_NOT_EXPECTED',
  stale: 'AMENDMENT_STALE',
  ledgerRequired: 'AMENDMENT_LEDGER_ADJUSTMENT_REQUIRED',
  ledgerUnverifiable: 'AMENDMENT_LEDGER_UNVERIFIABLE',
  inventoryBacked: 'AMENDMENT_INVENTORY_BACKED',
} as const

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MINOR = /^\d{1,15}$/
const validDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const d = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}
export const nightsBetween = (checkIn: string, checkOut: string): number => Math.round((Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86_400_000)
const sameAges = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i])

/**
 * Validates a proposal against what the booking is now. Every problem is listed at once. `today` is the UTC day (`YYYY-MM-DD`): a check-in that is being moved cannot be
 * moved into the past; the stay of a booking already in progress can still be shortened or extended at its check-out.
 */
export function validateAmendmentProposal(raw: unknown, current: AmendmentSubject, today: string): AmendmentValidation {
  const issues: AmendmentIssue[] = []
  const bad = (field: string, message: string) => { issues.push({ field, message }) }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, issues: [{ field: '*', message: 'The amendment must be an object' }] }
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!['checkIn', 'checkOut', 'rooms'].includes(key)) bad(key, `Unsupported field "${key.slice(0, 40)}"`)

  const proposal: BookingAmendmentProposal = {}
  const changes: AmendmentChange[] = []
  if (input.checkIn !== undefined && !validDay(input.checkIn)) bad('checkIn', 'checkIn must be a real date as YYYY-MM-DD')
  if (input.checkOut !== undefined && !validDay(input.checkOut)) bad('checkOut', 'checkOut must be a real date as YYYY-MM-DD')
  const newIn = validDay(input.checkIn) ? input.checkIn : undefined
  const newOut = validDay(input.checkOut) ? input.checkOut : undefined
  const checkIn = newIn ?? current.checkIn
  const checkOut = newOut ?? current.checkOut
  if (newIn !== undefined || newOut !== undefined) {
    if (!checkIn || !checkOut) bad('checkIn', 'This booking has no recorded stay dates; give both check-in and check-out')
    else {
      const nights = nightsBetween(checkIn, checkOut)
      if (nights < 1) bad('checkOut', 'Check-out must be after check-in')
      else if (nights > BOOKING_AMENDMENT_LIMITS.maxNights) bad('checkOut', `A stay is at most ${BOOKING_AMENDMENT_LIMITS.maxNights} nights`)
      if (newIn !== undefined && newIn !== current.checkIn && newIn < today) bad('checkIn', 'Check-in cannot be moved into the past')
    }
    if ((newIn !== undefined && newIn !== current.checkIn) || (newOut !== undefined && newOut !== current.checkOut)) {
      changes.push('STAY_DATES')
      if (newIn !== undefined) proposal.checkIn = newIn
      if (newOut !== undefined) proposal.checkOut = newOut
    }
  }

  if (input.rooms !== undefined) {
    if (!Array.isArray(input.rooms) || input.rooms.length === 0 || input.rooms.length > BOOKING_AMENDMENT_LIMITS.maxRooms) bad('rooms', `rooms must list 1 to ${BOOKING_AMENDMENT_LIMITS.maxRooms} rooms`)
    else {
      const seen = new Set<number>(); const normalized: AmendmentRoomChange[] = []; let differs = false
      input.rooms.forEach((entry, i) => {
        const r = entry as Record<string, unknown>
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { bad(`rooms.${i}`, 'Each room must be an object'); return }
        for (const key of Object.keys(r)) if (!['position', 'adults', 'children', 'childAges'].includes(key)) bad(`rooms.${i}.${key}`, `Unsupported field "${key.slice(0, 40)}"`)
        const position = r.position; const adults = r.adults; const children = r.children ?? 0; const ages = r.childAges ?? []
        const existing = Number.isInteger(position) ? current.rooms.find((c) => c.position === position) : undefined
        if (!Number.isInteger(position) || !existing) { bad(`rooms.${i}.position`, 'This booking has no room at that position'); return }
        if (seen.has(position as number)) { bad(`rooms.${i}.position`, 'A room is listed twice'); return }
        seen.add(position as number)
        if (!Number.isInteger(adults) || (adults as number) < 1 || (adults as number) > BOOKING_AMENDMENT_LIMITS.maxAdults) bad(`rooms.${i}.adults`, `Adults: 1 to ${BOOKING_AMENDMENT_LIMITS.maxAdults}`)
        if (!Number.isInteger(children) || (children as number) < 0 || (children as number) > BOOKING_AMENDMENT_LIMITS.maxChildren) bad(`rooms.${i}.children`, `Children: 0 to ${BOOKING_AMENDMENT_LIMITS.maxChildren}`)
        const ageList = Array.isArray(ages) ? ages : null
        if (!ageList || ageList.length !== children || ageList.some((a) => !Number.isInteger(a) || (a as number) < 0 || (a as number) > BOOKING_AMENDMENT_LIMITS.maxChildAge)) bad(`rooms.${i}.childAges`, `Give one age (0 to ${BOOKING_AMENDMENT_LIMITS.maxChildAge}) per child`)
        if (issues.some((x) => x.field.startsWith(`rooms.${i}.`))) return
        const next = { position: position as number, adults: adults as number, children: children as number, childAges: [...(ageList as number[])].sort((a, b) => a - b) }
        normalized.push(next)
        if (existing.adults !== next.adults || existing.children !== next.children || !sameAges(existing.childAges, next.childAges)) differs = true
      })
      if (differs && !issues.some((x) => x.field.startsWith('rooms'))) { proposal.rooms = normalized.sort((a, b) => a.position - b.position); changes.push('OCCUPANCY') }
    }
  }

  if (issues.length) return { ok: false, issues }
  if (changes.length === 0) return { ok: false, issues: [{ field: '*', message: 'Nothing would change: the proposal matches the booking as it is' }] }
  const stay = changes.includes('STAY_DATES') ? { checkIn, checkOut, nights: checkIn && checkOut ? nightsBetween(checkIn, checkOut) : null } : { checkIn: current.checkIn, checkOut: current.checkOut, nights: current.checkIn && current.checkOut ? nightsBetween(current.checkIn, current.checkOut) : null }
  return { ok: true, proposal, stay, changes }
}

export type AmendmentApprovalValidation = { ok: true; approval: { sellMinor: bigint; netMinor: bigint | null | undefined; cancelDeadline: Date | null | undefined } } | { ok: false; issues: AmendmentIssue[] }

/** Validates what an approver records. Integer minor units only; the sell must be positive; the net, when given, cannot exceed the sell. */
export function validateAmendmentApproval(raw: unknown): AmendmentApprovalValidation {
  const issues: AmendmentIssue[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, issues: [{ field: '*', message: 'The approval must be an object' }] }
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!['sellMinor', 'netMinor', 'cancelDeadline'].includes(key)) issues.push({ field: key, message: `Unsupported field "${key.slice(0, 40)}"` })
  let sell: bigint | null = null
  if (typeof input.sellMinor !== 'string' || !MINOR.test(input.sellMinor) || BigInt(input.sellMinor) <= 0n) issues.push({ field: 'sellMinor', message: 'The new sell total is required, as a positive whole number of minor units' })
  else sell = BigInt(input.sellMinor)
  let net: bigint | null | undefined
  if (input.netMinor === null) net = null
  else if (input.netMinor !== undefined) {
    if (typeof input.netMinor !== 'string' || !MINOR.test(input.netMinor)) issues.push({ field: 'netMinor', message: 'The new net must be a whole number of minor units' })
    else { net = BigInt(input.netMinor); if (sell !== null && net > sell) issues.push({ field: 'netMinor', message: 'The net cannot exceed the sell' }) }
  }
  let deadline: Date | null | undefined
  if (input.cancelDeadline === null) deadline = null
  else if (input.cancelDeadline !== undefined) {
    const d = typeof input.cancelDeadline === 'string' ? new Date(input.cancelDeadline) : null
    if (!d || Number.isNaN(d.getTime())) issues.push({ field: 'cancelDeadline', message: 'The cancellation deadline must be a date-time' })
    else deadline = d
  }
  if (issues.length || sell === null) return { ok: false, issues }
  return { ok: true, approval: { sellMinor: sell, netMinor: net, cancelDeadline: deadline } }
}

export type AmendmentDirection = 'INCREASE' | 'DECREASE' | 'NONE'
/** Signed difference (new minus old) in integer minor units, as a string. */
export function amendmentDifference(oldSellMinor: MinorString | bigint, newSellMinor: MinorString | bigint): { differenceMinor: string; direction: AmendmentDirection } {
  const d = BigInt(newSellMinor) - BigInt(oldSellMinor)
  return { differenceMinor: d.toString(), direction: d > 0n ? 'INCREASE' : d < 0n ? 'DECREASE' : 'NONE' }
}

/** What happens to the net and the markup: a given net recomputes the markup; no net makes both unknown. Never a stale number. */
export function amendedNetAndMarkup(sell: bigint, net: bigint | null | undefined): { netMinor: bigint | null; markupMinor: bigint | null } {
  if (net === null || net === undefined) return { netMinor: null, markupMinor: null }
  return { netMinor: net, markupMinor: sell - net }
}

/** The free-cancellation deadline after approval: the recorded one; otherwise unchanged when the dates did not move, and unknown (null) when they did. */
export function amendedCancelDeadline(current: Date | null, changes: readonly AmendmentChange[], recorded: Date | null | undefined): Date | null {
  if (recorded !== undefined) return recorded
  return changes.includes('STAY_DATES') ? null : current
}

/** A stored amendment as the Admin shows it. No guest data; net only with `booking.view.net`. */
export interface BookingAmendmentView {
  id: string
  status: BookingAmendmentStatus
  fromVersion: number
  proposal: BookingAmendmentProposal
  before: { checkIn: string | null; checkOut: string | null; nights: number | null; rooms: AmendmentSubject['rooms']; sellMinor: MinorString; netMinor: MinorString | null; cancelDeadline: string | null }
  approved: { sellMinor: MinorString; netMinor: MinorString | null; cancelDeadline: string | null; differenceMinor: MinorString; direction: AmendmentDirection } | null
  requestedAt: string
  decidedAt: string | null
  /** Document types already issued when this was approved. They are NOT reissued (revised vouchers and invoices are not built). */
  documentsNotReissued: string[]
  /** Set when the difference was recorded as an "awaiting Finance booking" money fact. */
  financeRecorded: boolean
}
