import { BadRequestException } from '@nestjs/common'
import { AGENT_REF_MAX, GUEST_TITLES, SPECIAL_REQUEST_CODES, SPECIAL_REQUEST_NOTE_MAX, type CheckoutGuest, type CheckoutSpecialRequests, type GuestTitle, type SpecialRequestCode } from '@bedbanks/contracts'

/** The same rule as the lead guest: letters first, then letters, marks, apostrophes, spaces, dots and hyphens; 1-80 characters. */
const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,79}$/u
/** An agent's file reference: printable, no control characters or angle brackets. */
const AGENT_REF = /^[\p{L}\p{N}][\p{L}\p{N} ._/#:-]*$/u

export interface CheckoutOccupancy { rooms: number; adults: number; children: number; childAges: number[]; leadGuest: { firstName: string; lastName: string } }
export interface NormalizedGuest { roomNumber: number; type: 'ADULT' | 'CHILD'; title: GuestTitle | null; firstName: string; lastName: string; age: number | null; isLead: boolean }
export interface NormalizedCheckout { guests: NormalizedGuest[] | null; agentRef: string | null; specialRequests: { codes: SpecialRequestCode[]; note?: string } | null }

const refuse = (code: string, message: string): never => { throw new BadRequestException({ code, message }) }
const sameName = (left: string, right: string) => left.trim().toLocaleLowerCase('en-US') === right.trim().toLocaleLowerCase('en-US')
const sortedAges = (ages: number[]) => [...ages].sort((a, b) => a - b).join(',')

/**
 * Validates checkout details against the held occupancy (ADR 0066). Identical rooms: every room holds `adults` adults and `children` children
 * whose ages are exactly the searched child ages. The lead guest is room 1's first adult and must be the lead guest the booking is made for.
 * Nothing here is commercial: none of it changes price, occupancy or idempotency.
 */
export function normalizeCheckout(input: { guests?: CheckoutGuest[]; agentRef?: string; specialRequests?: CheckoutSpecialRequests }, occupancy: CheckoutOccupancy): NormalizedCheckout {
  let guests: NormalizedGuest[] | null = null
  if (input.guests !== undefined) {
    const expected = occupancy.rooms * (occupancy.adults + occupancy.children)
    if (input.guests.length !== expected) refuse('GUEST_COUNT_MISMATCH', `Enter a name for each of the ${expected} guests.`)
    guests = []
    for (let room = 1; room <= occupancy.rooms; room++) {
      const inRoom = input.guests.filter((g) => g.roomNumber === room)
      const adults = inRoom.filter((g) => g.type === 'ADULT')
      const children = inRoom.filter((g) => g.type === 'CHILD')
      if (adults.length !== occupancy.adults || children.length !== occupancy.children) refuse('ROOM_OCCUPANCY_MISMATCH', `Room ${room} must have ${occupancy.adults} adult(s) and ${occupancy.children} child(ren).`)
      if (children.some((c) => !Number.isInteger(c.age)) || sortedAges(children.map((c) => c.age as number)) !== sortedAges(occupancy.childAges)) refuse('CHILD_AGE_MISMATCH', `Room ${room}: child ages must be ${occupancy.childAges.join(', ') || 'none'}.`)
      for (const g of [...adults, ...children]) {
        const firstName = g.firstName.trim().replace(/\s+/g, ' ')
        const lastName = g.lastName.trim().replace(/\s+/g, ' ')
        if (!NAME.test(firstName) || !NAME.test(lastName)) refuse('GUEST_NAME_INVALID', 'Guest names must use letters (1 to 80 characters).')
        if (g.title !== undefined && !(GUEST_TITLES as readonly string[]).includes(g.title)) refuse('GUEST_TITLE_INVALID', 'Choose a title from the list.')
        if (g.type === 'ADULT' && g.age !== undefined) refuse('GUEST_AGE_INVALID', 'Only children carry an age.')
        guests.push({ roomNumber: room, type: g.type, title: g.title ?? null, firstName, lastName, age: g.type === 'CHILD' ? g.age as number : null, isLead: false })
      }
    }
    if (input.guests.some((g) => !Number.isInteger(g.roomNumber) || g.roomNumber < 1 || g.roomNumber > occupancy.rooms)) refuse('ROOM_NUMBER_INVALID', 'A guest is assigned to a room that is not in this booking.')
    const lead = guests.find((g) => g.roomNumber === 1 && g.type === 'ADULT')!
    if (!sameName(lead.firstName, occupancy.leadGuest.firstName) || !sameName(lead.lastName, occupancy.leadGuest.lastName)) refuse('LEAD_GUEST_MISMATCH', 'The lead guest must be the first adult in room 1.')
    lead.isLead = true
  }

  let agentRef: string | null = null
  if (input.agentRef !== undefined) {
    const value = input.agentRef.trim()
    if (value.length > AGENT_REF_MAX || (value && !AGENT_REF.test(value))) refuse('AGENT_REF_INVALID', `The agent reference must be up to ${AGENT_REF_MAX} letters, digits and . _ / # : - characters.`)
    agentRef = value || null
  }

  let specialRequests: NormalizedCheckout['specialRequests'] = null
  if (input.specialRequests !== undefined) {
    const codes = [...new Set(input.specialRequests.codes)]
    if (codes.some((code) => !(SPECIAL_REQUEST_CODES as readonly string[]).includes(code))) refuse('SPECIAL_REQUEST_INVALID', 'Choose special requests from the list.')
    if (codes.includes('TWIN_BEDS') && codes.includes('DOUBLE_BED')) refuse('SPECIAL_REQUEST_CONFLICT', 'Choose twin beds or a double bed, not both.')
    // Free text is kept to one line of printable characters: it is printed on the voucher, and markup characters are escaped when rendered.
    const note = (input.specialRequests.note ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (note.length > SPECIAL_REQUEST_NOTE_MAX) refuse('SPECIAL_REQUEST_NOTE_TOO_LONG', `Keep the note to ${SPECIAL_REQUEST_NOTE_MAX} characters.`)
    const ordered = SPECIAL_REQUEST_CODES.filter((code) => codes.includes(code))
    specialRequests = ordered.length || note ? { codes: ordered, ...(note ? { note } : {}) } : null
  }
  return { guests, agentRef, specialRequests }
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** Up to three CC addresses for the confirmation email, de-duplicated and without the primary recipient. */
export function normalizeCcEmails(input: string[] | undefined, primary: string | null): string[] {
  const out: string[] = []
  for (const raw of input ?? []) {
    const email = raw.trim().toLowerCase()
    if (!email) continue
    if (email.length > 254 || !EMAIL.test(email)) refuse('CC_EMAIL_INVALID', 'Enter valid CC email addresses.')
    if (email !== primary?.toLowerCase() && !out.includes(email)) out.push(email)
  }
  if (out.length > 3) refuse('CC_EMAIL_TOO_MANY', 'Add at most three CC addresses.')
  return out
}

export function validRecipient(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? ''
  return value.length <= 254 && EMAIL.test(value) ? value : null
}
