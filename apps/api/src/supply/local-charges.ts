import { LOCAL_CHARGE_BASES, LOCAL_CHARGE_KINDS, LOCAL_CHARGE_LIMITS, type HotelLocalCharge, type LocalChargeBasis } from '@bedbanks/contracts'

/**
 * Local charges paid at the hotel (ADR 0067, F-04). Pure: no I/O, integer minor units only.
 *
 * They are disclosed, never added to the price: Agent offers carry them with an estimate for the stay, and the voucher, invoice and confirmation
 * email list them as payable at the hotel. A stored value that does not parse is dropped from disclosure and the reason is visible to Admin on save.
 */
const MINOR = /^(0|[1-9][0-9]{0,15})$/
const CURRENCY = /^[A-Z]{3}$/
const CONTROL = /[\u0000-\u001f]/

/** Validates the full set sent by Hotel Setup. Every problem is returned, so the operator fixes them in one pass. */
export function normaliseLocalCharges(value: unknown, errors: string[]): HotelLocalCharge[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > LOCAL_CHARGE_LIMITS.charges) { errors.push(`localCharges: provide a list of at most ${LOCAL_CHARGE_LIMITS.charges} charges`); return undefined }
  const out: HotelLocalCharge[] = []
  value.forEach((raw, i) => {
    const at = `localCharges[${i}]`
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
    const kind = r.kind as HotelLocalCharge['kind']
    const basis = r.basis as LocalChargeBasis
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    const amount = typeof r.amountMinor === 'string' ? r.amountMinor : typeof r.amountMinor === 'number' && Number.isSafeInteger(r.amountMinor) ? String(r.amountMinor) : ''
    const currency = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : ''
    const maxNights = r.maxNights === undefined || r.maxNights === null ? null : r.maxNights
    let ok = true
    const bad = (message: string) => { errors.push(`${at}.${message}`); ok = false }
    if (!(LOCAL_CHARGE_KINDS as readonly string[]).includes(kind)) bad(`kind: one of ${LOCAL_CHARGE_KINDS.join(', ')}`)
    if (!(LOCAL_CHARGE_BASES as readonly string[]).includes(basis)) bad(`basis: one of ${LOCAL_CHARGE_BASES.join(', ')}`)
    if (label.length < 1 || label.length > LOCAL_CHARGE_LIMITS.labelMax || CONTROL.test(label)) bad(`label: 1 to ${LOCAL_CHARGE_LIMITS.labelMax} characters`)
    if (!MINOR.test(amount)) bad('amountMinor: a whole number of minor units, 0 or more')
    if (!CURRENCY.test(currency)) bad('currency: a 3-letter ISO-4217 code')
    if (maxNights !== null && !(typeof maxNights === 'number' && Number.isInteger(maxNights) && maxNights >= 1 && maxNights <= LOCAL_CHARGE_LIMITS.maxNights)) bad(`maxNights: a whole number from 1 to ${LOCAL_CHARGE_LIMITS.maxNights}, or empty`)
    if (maxNights !== null && (basis === 'PER_ROOM_PER_STAY' || basis === 'PER_PERSON_PER_STAY')) bad('maxNights: only a per-night charge takes a night cap')
    if (ok) out.push({ kind, label, amountMinor: amount, currency, basis, maxNights: maxNights as number | null })
  })
  return out
}

/** Stored JSON read back as charges. Anything malformed is skipped rather than disclosed wrongly. */
export function readLocalCharges(stored: unknown): HotelLocalCharge[] {
  const errors: string[] = []
  return Array.isArray(stored) ? normaliseLocalCharges(stored, errors) ?? [] : []
}

/** The estimated amount of one charge for a stay. Persons are every guest; per-night charges respect the night cap. */
export function estimateLocalCharge(charge: HotelLocalCharge, stay: { nights: number; rooms: number; guests: number }): bigint {
  const amount = BigInt(charge.amountMinor)
  const nights = BigInt(charge.maxNights === null ? stay.nights : Math.min(stay.nights, charge.maxNights))
  switch (charge.basis) {
    case 'PER_ROOM_PER_NIGHT': return amount * nights * BigInt(stay.rooms)
    case 'PER_PERSON_PER_NIGHT': return amount * nights * BigInt(stay.guests)
    case 'PER_ROOM_PER_STAY': return amount * BigInt(stay.rooms)
    case 'PER_PERSON_PER_STAY': return amount * BigInt(stay.guests)
  }
}

/** Charges as an Agent offer, document or email states them. */
export function payAtHotel(stored: unknown, stay: { nights: number; rooms: number; guests: number }) {
  return readLocalCharges(stored).map((charge) => ({ kind: charge.kind, label: charge.label, amountMinor: Number(charge.amountMinor), currency: charge.currency, basis: charge.basis, estimatedTotalMinor: Number(estimateLocalCharge(charge, stay)) }))
}
