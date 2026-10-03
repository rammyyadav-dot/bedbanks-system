import {
  EXTERNAL_IDENTIFIER_SCHEME_PATTERN, HOTEL_CONTACT_KINDS, HOTEL_POLICY_KEYS, HOTEL_PUBLICATION_REQUIREMENTS,
  type HotelCompleteness, type HotelContact, type HotelContacts, type HotelPolicies, type HotelRequirementResult, type HotelSetupSave,
} from '@bedbanks/contracts'

/**
 * Pure rules for Hotel Setup (ADR 0021): input normalisation and validation, and the publication requirements. No I/O.
 * A draft may be saved incomplete; only `assessCompleteness` decides whether a hotel may be published.
 */

const COUNTRY = /^[A-Z]{2}$/
const PROPERTY_TYPE = /^[A-Z][A-Z_]{1,31}$/
const LANGUAGE = /^[a-z]{2}$/
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const COORDINATE = /^-?\d{1,3}(\.\d{1,6})?$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/
const PHONE = /^\+?[0-9][0-9 ()-]{4,30}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const SCHEME_VALUE = /^\S(.{0,78}\S)?$/

export const MAX = { name: 160, legalName: 200, chain: 120, area: 120, address: 300, postal: 20, short: 500, full: 4000, notes: 2000, policy: 1000, source: 80, starSource: 120, contactName: 120, languages: 20, identifiers: 10 } as const

/** True for an IANA zone name the runtime knows ("UTC" is accepted explicitly). Case must match exactly. */
export function isIanaTimeZone(value: string): boolean {
  if (value === 'UTC') return true
  try { return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone').includes(value) } catch { return false }
}

export interface CurrentSetup {
  name: string; propertyType: string; countryCode: string; city: string; address: string | null; latitude: string | null; longitude: string | null; timeZone: string
  starRating: number | null; starVerified: boolean
  shortDescription: string | null; checkInTime: string | null; checkOutTime: string | null; contacts: HotelContacts
  activeRooms: number
}

const present = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim().length > 0

/** The publication requirements, evaluated on stored data. `detail` says exactly what is missing. */
export function assessCompleteness(c: CurrentSetup): HotelCompleteness {
  const reservations = c.contacts.reservations
  const met = (key: string): [boolean, string] => {
    switch (key) {
      case 'NAME': return [present(c.name), 'A hotel name is required.']
      case 'PROPERTY_TYPE': return [present(c.propertyType), 'Choose a property type.']
      case 'COUNTRY': return [COUNTRY.test(c.countryCode), 'Enter a two-letter ISO country code.']
      case 'CITY': return [present(c.city), 'Enter the city.']
      case 'ADDRESS': return [present(c.address), 'Enter the street address.']
      case 'COORDINATES': return [c.latitude !== null && c.longitude !== null, 'Enter latitude and longitude together.']
      case 'TIME_ZONE': return [isIanaTimeZone(c.timeZone), 'Enter a valid IANA time zone, for example Asia/Dubai.']
      case 'STAR_CATEGORY': return [c.starRating !== null && c.starRating >= 1 && c.starRating <= 5 && c.starVerified, c.starRating === null ? 'No star category is recorded.' : 'The star category has not been marked as verified.']
      case 'SHORT_DESCRIPTION': return [present(c.shortDescription), 'Write a short description.']
      case 'CHECK_IN_OUT': return [Boolean(c.checkInTime && c.checkOutTime), 'Enter both the check-in and the check-out time.']
      case 'RESERVATIONS_CONTACT': return [Boolean(reservations && present(reservations.name) && (present(reservations.email) || present(reservations.phone))), 'Enter a reservations contact with a name and an email or phone number.']
      case 'ACTIVE_ROOM': return [c.activeRooms > 0, 'Add at least one active canonical room.']
      default: return [false, 'Unknown requirement.']
    }
  }
  const requirements: HotelRequirementResult[] = HOTEL_PUBLICATION_REQUIREMENTS.map((r) => { const [ok, detail] = met(r.key); return { key: r.key, label: r.label, section: r.section, met: ok, detail: ok ? 'Met.' : detail } })
  const metCount = requirements.filter((r) => r.met).length
  return { requirements, met: metCount, total: requirements.length, percent: Math.round((metCount / requirements.length) * 100), publishable: metCount === requirements.length }
}

/** Requirements met before the change and unmet after it: a published hotel may not lose them by an edit. */
export function regressions(before: HotelCompleteness, after: HotelCompleteness): HotelRequirementResult[] {
  const was = new Set(before.requirements.filter((r) => r.met).map((r) => r.key))
  return after.requirements.filter((r) => !r.met && was.has(r.key))
}

export interface NormalisedSave {
  hotel: { name?: string; propertyType?: string; countryCode?: string; city?: string; address?: string | null; latitude?: string | null; longitude?: string | null; timeZone?: string; starRating?: number | null }
  profile: {
    legalName?: string | null; chainName?: string | null; brandName?: string | null; area?: string | null; postalCode?: string | null
    shortDescription?: string | null; fullDescription?: string | null; languages?: string[]; checkInTime?: string | null; checkOutTime?: string | null
    operationalNotes?: string | null; contacts?: HotelContacts; policies?: HotelPolicies; sourceSystem?: string | null; ownerUserId?: string | null; starSource?: string | null
  }
  starVerified?: boolean
  externalIdentifiers?: Array<{ scheme: string; value: string }>
  changed: string[]
}

type Errors = string[]

function text(errors: Errors, name: string, value: unknown, max: number, opts: { required?: boolean; multiline?: boolean } = {}): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || (typeof value === 'string' && value.trim() === '')) { if (opts.required) errors.push(`${name}: is required`); return opts.required ? undefined : null }
  if (typeof value !== 'string') { errors.push(`${name}: must be text`); return undefined }
  const t = value.trim()
  if (t.length > max) { errors.push(`${name}: must be at most ${max} characters`); return undefined }
  if (CONTROL.test(t) || (!opts.multiline && /[\n\r]/.test(t))) { errors.push(`${name}: contains characters that are not allowed`); return undefined }
  return t
}

function contact(errors: Errors, kind: string, value: unknown): HotelContact | undefined {
  if (value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`contacts.${kind}: must be an object`); return undefined }
  const v = value as Record<string, unknown>
  for (const key of Object.keys(v)) if (!['name', 'email', 'phone'].includes(key)) errors.push(`contacts.${kind}.${key}: is not a supported field`)
  const name = text(errors, `contacts.${kind}.name`, v.name, MAX.contactName)
  const email = text(errors, `contacts.${kind}.email`, v.email, 254)
  const phone = text(errors, `contacts.${kind}.phone`, v.phone, 32)
  if (email && !EMAIL.test(email)) errors.push(`contacts.${kind}.email: is not a valid email address`)
  if (phone && !PHONE.test(phone)) errors.push(`contacts.${kind}.phone: is not a valid phone number`)
  const out: HotelContact = {}
  if (name) out.name = name
  if (email) out.email = email
  if (phone) out.phone = phone
  return out
}

/**
 * Validates a save request against the allowed fields and returns normalised data. Unknown keys are rejected. `errors` is empty
 * only when every supplied field is valid; nothing is partially applied. Values are never echoed into error text.
 */
export function normaliseSave(body: Partial<HotelSetupSave>): { data: NormalisedSave; errors: Errors } {
  const errors: Errors = []
  const allowed = new Set(['idempotencyKey', 'expectedToken', 'reason', 'name', 'propertyType', 'legalName', 'chainName', 'brandName', 'countryCode', 'city', 'area', 'address', 'postalCode', 'latitude', 'longitude', 'timeZone', 'starRating', 'starSource', 'starVerified', 'shortDescription', 'fullDescription', 'languages', 'checkInTime', 'checkOutTime', 'operationalNotes', 'contacts', 'policies', 'sourceSystem', 'ownerUserId', 'externalIdentifiers'])
  for (const key of Object.keys(body ?? {})) if (!allowed.has(key)) errors.push(`${key}: is not a supported field`)
  const b = (body ?? {}) as Record<string, unknown>
  const data: NormalisedSave = { hotel: {}, profile: {}, changed: [] }
  const set = <T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined, field: string) => { if (value !== undefined) { target[key] = value as T[K]; data.changed.push(field) } }

  set(data.hotel, 'name', text(errors, 'name', b.name, MAX.name, { required: true }) ?? undefined, 'name')
  const propertyType = text(errors, 'propertyType', b.propertyType, 32, { required: true })
  if (typeof propertyType === 'string') { if (PROPERTY_TYPE.test(propertyType)) set(data.hotel, 'propertyType', propertyType, 'propertyType'); else errors.push('propertyType: use upper-case letters and underscores, for example HOTEL') }
  const country = text(errors, 'countryCode', b.countryCode, 2, { required: true })
  if (typeof country === 'string') { const c = country.toUpperCase(); if (COUNTRY.test(c)) set(data.hotel, 'countryCode', c, 'countryCode'); else errors.push('countryCode: must be a two-letter ISO country code') }
  set(data.hotel, 'city', text(errors, 'city', b.city, 120, { required: true }) ?? undefined, 'city')
  set(data.hotel, 'address', text(errors, 'address', b.address, MAX.address), 'address')
  const tz = text(errors, 'timeZone', b.timeZone, 64, { required: true })
  if (typeof tz === 'string') { if (isIanaTimeZone(tz)) set(data.hotel, 'timeZone', tz, 'timeZone'); else errors.push('timeZone: must be an IANA time zone such as Asia/Dubai') }

  for (const [field, limit] of [['latitude', 90], ['longitude', 180]] as const) {
    const raw = b[field]
    if (raw === undefined) continue
    if (raw === null || raw === '') { set(data.hotel, field, null, field); continue }
    if (typeof raw !== 'string' || !COORDINATE.test(raw.trim())) { errors.push(`${field}: enter a decimal number with at most 6 decimal places`); continue }
    if (Math.abs(Number(raw)) > limit) { errors.push(`${field}: must be between -${limit} and ${limit}`); continue }
    set(data.hotel, field, raw.trim(), field)
  }
  if ((b.latitude === null || b.latitude === '') !== (b.longitude === null || b.longitude === '') && b.latitude !== undefined && b.longitude !== undefined) errors.push('latitude and longitude: set or clear both together')

  if (b.starRating !== undefined) {
    if (b.starRating === null) set(data.hotel, 'starRating', null, 'starRating')
    else if (typeof b.starRating === 'number' && Number.isInteger(b.starRating) && b.starRating >= 1 && b.starRating <= 5) set(data.hotel, 'starRating', b.starRating, 'starRating')
    else errors.push('starRating: must be a whole number from 1 to 5, or empty')
  }
  if (b.starVerified !== undefined) { if (typeof b.starVerified === 'boolean') { data.starVerified = b.starVerified; data.changed.push('starVerified') } else errors.push('starVerified: must be true or false') }

  const p = data.profile
  set(p, 'legalName', text(errors, 'legalName', b.legalName, MAX.legalName), 'legalName')
  set(p, 'chainName', text(errors, 'chainName', b.chainName, MAX.chain), 'chainName')
  set(p, 'brandName', text(errors, 'brandName', b.brandName, MAX.chain), 'brandName')
  set(p, 'area', text(errors, 'area', b.area, MAX.area), 'area')
  set(p, 'postalCode', text(errors, 'postalCode', b.postalCode, MAX.postal), 'postalCode')
  set(p, 'shortDescription', text(errors, 'shortDescription', b.shortDescription, MAX.short, { multiline: true }), 'shortDescription')
  set(p, 'fullDescription', text(errors, 'fullDescription', b.fullDescription, MAX.full, { multiline: true }), 'fullDescription')
  set(p, 'operationalNotes', text(errors, 'operationalNotes', b.operationalNotes, MAX.notes, { multiline: true }), 'operationalNotes')
  set(p, 'sourceSystem', text(errors, 'sourceSystem', b.sourceSystem, MAX.source), 'sourceSystem')
  set(p, 'starSource', text(errors, 'starSource', b.starSource, MAX.starSource), 'starSource')
  const owner = text(errors, 'ownerUserId', b.ownerUserId, 80)
  if (owner !== undefined) set(p, 'ownerUserId', owner, 'ownerUserId')

  for (const [field, key] of [['checkInTime', 'checkInTime'], ['checkOutTime', 'checkOutTime']] as const) {
    const raw = b[field]
    if (raw === undefined) continue
    if (raw === null || raw === '') set(p, key, null, field)
    else if (typeof raw === 'string' && TIME.test(raw)) set(p, key, raw, field)
    else errors.push(`${field}: use 24-hour HH:MM, for example 14:00`)
  }

  if (b.languages !== undefined) {
    if (!Array.isArray(b.languages) || b.languages.length > MAX.languages) errors.push(`languages: provide at most ${MAX.languages} two-letter ISO 639-1 codes`)
    else if (!b.languages.every((l) => typeof l === 'string' && LANGUAGE.test(l)) || new Set(b.languages).size !== b.languages.length) errors.push('languages: use unique lower-case two-letter ISO 639-1 codes, for example en')
    else set(p, 'languages', [...(b.languages as string[])], 'languages')
  }

  if (b.contacts !== undefined) {
    if (typeof b.contacts !== 'object' || b.contacts === null || Array.isArray(b.contacts)) errors.push('contacts: must be an object')
    else {
      const out: HotelContacts = {}
      for (const [kind, value] of Object.entries(b.contacts as Record<string, unknown>)) {
        if (!(HOTEL_CONTACT_KINDS as readonly string[]).includes(kind)) { errors.push(`contacts.${kind}: is not a supported contact`); continue }
        const c = contact(errors, kind, value)
        if (c && Object.keys(c).length) out[kind as keyof HotelContacts] = c
      }
      set(p, 'contacts', out, 'contacts')
    }
  }

  if (b.policies !== undefined) {
    if (typeof b.policies !== 'object' || b.policies === null || Array.isArray(b.policies)) errors.push('policies: must be an object')
    else {
      const out: HotelPolicies = {}
      for (const [key, value] of Object.entries(b.policies as Record<string, unknown>)) {
        if (!(HOTEL_POLICY_KEYS as readonly string[]).includes(key)) { errors.push(`policies.${key}: is not a supported policy`); continue }
        const t = text(errors, `policies.${key}`, value, MAX.policy, { multiline: true })
        if (t) out[key as keyof HotelPolicies] = t
      }
      set(p, 'policies', out, 'policies')
    }
  }

  if (b.externalIdentifiers !== undefined) {
    if (!Array.isArray(b.externalIdentifiers) || b.externalIdentifiers.length > MAX.identifiers) errors.push(`externalIdentifiers: provide at most ${MAX.identifiers} entries`)
    else {
      const out: Array<{ scheme: string; value: string }> = []
      const seen = new Set<string>()
      for (const [i, entry] of (b.externalIdentifiers as unknown[]).entries()) {
        const e = entry as { scheme?: unknown; value?: unknown }
        const scheme = typeof e?.scheme === 'string' ? e.scheme.trim().toUpperCase() : ''
        const value = typeof e?.value === 'string' ? e.value.trim() : ''
        if (!EXTERNAL_IDENTIFIER_SCHEME_PATTERN.test(scheme)) { errors.push(`externalIdentifiers[${i}].scheme: use 2-32 upper-case letters, digits or underscores, starting with a letter`); continue }
        if (!SCHEME_VALUE.test(value) || CONTROL.test(value)) { errors.push(`externalIdentifiers[${i}].value: enter 1-80 characters without surrounding spaces`); continue }
        if (seen.has(scheme)) { errors.push(`externalIdentifiers[${i}].scheme: a hotel has one identifier per scheme`); continue }
        seen.add(scheme); out.push({ scheme, value })
      }
      data.externalIdentifiers = out; data.changed.push('externalIdentifiers')
    }
  }
  return { data, errors }
}
