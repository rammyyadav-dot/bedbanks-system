/**
 * Room-type occupancy profile (ADR 0114).
 *
 * The three stored caps stay the search and hold gates: a party fits the room when adults ≤ maxAdults,
 * children ≤ maxChildren and adults + children ≤ maxOccupancy. Those caps are independent, so
 * maxAdults + maxChildren may be greater than maxOccupancy (a room can sleep 3 adults or 2 children,
 * but not both at once). Requests that omit this profile keep the older simultaneous-cap rule.
 *
 * Age-band percents are integer basis points (5000 = 50% of the adult rate). They are not a sell price
 * and are not applied by the contracted evaluator; contract child supplements remain that price.
 */

export const ROOM_AGE_MAX = 99
export const ROOM_AGE_BAND_KINDS = ['INFANT', 'CHILD', 'ADULT'] as const
export type RoomAgeBandKind = (typeof ROOM_AGE_BAND_KINDS)[number]
export const ROOM_AGE_CHARGES = ['FREE', 'PERCENT'] as const
export type RoomAgeCharge = (typeof ROOM_AGE_CHARGES)[number]

export interface RoomAgeBand {
  kind: RoomAgeBandKind
  minAge: number
  maxAge: number
  /** FREE is the adult base rate, or no child supplement. PERCENT is a share of the adult rate. */
  charge: RoomAgeCharge
  /** 1–10000 basis points when charge is PERCENT. Null when FREE. */
  percentBp: number | null
}

export interface RoomParty { adults: number; children: number }

export interface RoomOccupancyCaps {
  maxAdults: number
  maxChildren: number
  maxOccupancy: number
}

export interface RoomOccupancyPolicy {
  baseOccupancy: number
  views: string
  inclusions: string
  description: string
  maxAdultsWithChildren: number
  minOccupancy: number
  minAdults: number
  maxExtraBeds: number
  /** When true, guests on an extra bed consume maxOccupancy. When false they sit outside that cap, up to maxExtraBeds. */
  extraBedCountsTowardMax: boolean
  eventMaxOccupancy: number | null
  lockAfterFirstBooking: boolean
  blocked: RoomParty[]
  childrenAllowed: boolean
  ageBands: RoomAgeBand[]
  /** One child in the party does not take a bed and does not count toward occupancy. */
  sharingBedAllowed: boolean
  childExtraBedAllowed: boolean
  adultExtraBedAllowed: boolean
}

export type OccupancyCellState = 'bookable' | 'blocked' | 'invalid'
export interface OccupancyCell extends RoomParty { state: OccupancyCellState; reason: string }

const CONTROL = /[\u0000-\u001f]/
const whole = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

export function defaultAgeBands(childrenAllowed: boolean): RoomAgeBand[] {
  if (!childrenAllowed) return [{ kind: 'ADULT', minAge: 0, maxAge: ROOM_AGE_MAX, charge: 'FREE', percentBp: null }]
  return [
    { kind: 'INFANT', minAge: 0, maxAge: 1, charge: 'FREE', percentBp: null },
    { kind: 'CHILD', minAge: 2, maxAge: 11, charge: 'PERCENT', percentBp: 5000 },
    { kind: 'ADULT', minAge: 12, maxAge: ROOM_AGE_MAX, charge: 'FREE', percentBp: null },
  ]
}

/** A policy an editor can show for a room that has never stored one. */
export function deriveOccupancyPolicy(caps: RoomOccupancyCaps, extraBedSupported: boolean): RoomOccupancyPolicy {
  const childrenAllowed = caps.maxChildren > 0
  return {
    baseOccupancy: Math.min(Math.max(caps.maxAdults, 1), Math.max(caps.maxOccupancy, 1)),
    views: '', inclusions: '', description: '',
    maxAdultsWithChildren: Math.max(caps.maxAdults, 0),
    minOccupancy: 1,
    minAdults: 1,
    maxExtraBeds: extraBedSupported ? 1 : 0,
    extraBedCountsTowardMax: true,
    eventMaxOccupancy: null,
    lockAfterFirstBooking: false,
    blocked: [],
    childrenAllowed,
    ageBands: defaultAgeBands(childrenAllowed),
    sharingBedAllowed: false,
    childExtraBedAllowed: extraBedSupported,
    adultExtraBedAllowed: extraBedSupported,
  }
}

export function childAgeLabel(policy: RoomOccupancyPolicy | null, maxChildren: number): string {
  if (maxChildren <= 0 || (policy && !policy.childrenAllowed)) return 'Children: not accepted'
  if (!policy) return 'Children: ages not recorded'
  const kids = policy.ageBands.filter((band) => band.kind !== 'ADULT')
  if (kids.length === 0) return 'Children: not accepted'
  const min = Math.min(...kids.map((band) => band.minAge))
  const max = Math.max(...kids.map((band) => band.maxAge))
  return `Children: ${min}–${max} yrs`
}

export function compatibilityNote(policy: RoomOccupancyPolicy, caps: RoomOccupancyCaps): string {
  const sharing = policy.sharingBedAllowed
    ? 'Sharing bed: yes — one child does not count toward occupancy.'
    : 'Sharing bed: no — each child counts toward total occupancy.'
  return `Room max occupancy: ${caps.maxOccupancy} guests. The child age bands are capped to this limit. ${sharing} Agent search admits a party when the three caps fit; minimums, blocked cells, sharing and extra beds are stored on the room and are not yet a second search price. Contract child supplements stay on the contract.`
}

function text(value: unknown, max: number, field: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') { errors.push(`${field}: must be text`); return undefined }
  const trimmed = value.trim()
  if (trimmed.length > max || CONTROL.test(trimmed)) { errors.push(`${field}: must be at most ${max} characters without control characters`); return undefined }
  return trimmed
}

function bandProblems(bands: unknown, childrenAllowed: boolean, errors: string[]): RoomAgeBand[] | undefined {
  if (!Array.isArray(bands) || bands.length < 1 || bands.length > 6) { errors.push('policy.ageBands: provide 1 to 6 age bands'); return undefined }
  const out: RoomAgeBand[] = []
  for (const [i, raw] of bands.entries()) {
    const band = raw as Record<string, unknown> | null
    if (!band || typeof band !== 'object' || Array.isArray(band)) { errors.push(`policy.ageBands[${i}]: must be an object`); continue }
    for (const key of Object.keys(band)) if (!['kind', 'minAge', 'maxAge', 'charge', 'percentBp'].includes(key)) errors.push(`policy.ageBands[${i}].${key}: is not a supported field`)
    if (!(ROOM_AGE_BAND_KINDS as readonly string[]).includes(band.kind as string)) errors.push(`policy.ageBands[${i}].kind: must be INFANT, CHILD or ADULT`)
    if (!whole(band.minAge, 0, ROOM_AGE_MAX) || !whole(band.maxAge, 0, ROOM_AGE_MAX) || (band.minAge as number) > (band.maxAge as number)) errors.push(`policy.ageBands[${i}]: ages must be whole years from 0 to ${ROOM_AGE_MAX} with min at or below max`)
    if (!(ROOM_AGE_CHARGES as readonly string[]).includes(band.charge as string)) errors.push(`policy.ageBands[${i}].charge: must be FREE or PERCENT`)
    const charge = band.charge as RoomAgeCharge
    let percentBp: number | null = null
    if (charge === 'PERCENT') {
      if (!whole(band.percentBp, 1, 10_000)) errors.push(`policy.ageBands[${i}].percentBp: must be a whole number of basis points from 1 to 10000`)
      else percentBp = band.percentBp as number
    } else if (band.percentBp !== null && band.percentBp !== undefined) errors.push(`policy.ageBands[${i}].percentBp: must be empty when the charge is free`)
    if ((ROOM_AGE_BAND_KINDS as readonly string[]).includes(band.kind as string) && whole(band.minAge, 0, ROOM_AGE_MAX) && whole(band.maxAge, 0, ROOM_AGE_MAX)) {
      out.push({ kind: band.kind as RoomAgeBandKind, minAge: band.minAge as number, maxAge: band.maxAge as number, charge: charge === 'PERCENT' ? 'PERCENT' : 'FREE', percentBp })
    }
  }
  if (out.length !== bands.length) return undefined
  const adult = out.filter((band) => band.kind === 'ADULT')
  if (adult.length !== 1 || out[out.length - 1]?.kind !== 'ADULT') errors.push('policy.ageBands: exactly one adult band, and it must be the last')
  if (adult[0] && (adult[0].charge !== 'FREE' || adult[0].minAge > adult[0].maxAge)) errors.push('policy.ageBands: the adult band is the base rate and cannot be a percent of itself')
  if (out[0]?.minAge !== 0) errors.push('policy.ageBands: the first band must start at age 0')
  if (out[out.length - 1]?.maxAge !== ROOM_AGE_MAX) errors.push(`policy.ageBands: the adult band must end at age ${ROOM_AGE_MAX}`)
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].minAge !== out[i - 1].maxAge + 1) errors.push('policy.ageBands: bands must cover every age once, with no gap and no overlap')
  }
  if (!childrenAllowed && (out.length !== 1 || out[0]?.kind !== 'ADULT')) errors.push('policy.ageBands: a room that does not accept children has a single adult band')
  if (childrenAllowed && !out.some((band) => band.kind !== 'ADULT')) errors.push('policy.ageBands: a room that accepts children needs an infant or child band')
  return out
}

/** Reads a stored profile against the room's caps. A missing or malformed value is "not recorded", never a guessed policy. */
export function parseOccupancyPolicy(json: unknown, caps: RoomOccupancyCaps): RoomOccupancyPolicy | null {
  const root = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>).occupancyPolicy : undefined
  if (root === undefined || root === null) return null
  const { policy, errors } = normaliseOccupancyPolicy(root, caps)
  return policy && errors.length === 0 ? policy : null
}

export function normaliseOccupancyPolicy(value: unknown, caps: RoomOccupancyCaps): { policy?: RoomOccupancyPolicy; errors: string[] } {
  const errors: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { errors: ['policy: must be an object'] }
  const raw = value as Record<string, unknown>
  const allowed = ['baseOccupancy', 'views', 'inclusions', 'description', 'maxAdultsWithChildren', 'minOccupancy', 'minAdults', 'maxExtraBeds', 'extraBedCountsTowardMax', 'eventMaxOccupancy', 'lockAfterFirstBooking', 'blocked', 'childrenAllowed', 'ageBands', 'sharingBedAllowed', 'childExtraBedAllowed', 'adultExtraBedAllowed']
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) errors.push(`policy.${key}: is not a supported field`)
  if (!whole(caps.maxAdults, 1, 30)) errors.push('maxAdults: must be a whole number from 1 to 30')
  if (!whole(caps.maxChildren, 0, 20)) errors.push('maxChildren: must be a whole number from 0 to 20')
  if (!whole(caps.maxOccupancy, 1, 40)) errors.push('maxOccupancy: must be a whole number from 1 to 40')
  if (errors.some((error) => error.startsWith('max'))) return { errors }
  if (caps.maxOccupancy < caps.maxAdults) errors.push('maxOccupancy: must be at least the adult maximum')
  if (caps.maxOccupancy > caps.maxAdults + caps.maxChildren) errors.push('maxOccupancy: cannot exceed maxAdults plus maxChildren')
  const baseOccupancy = raw.baseOccupancy
  const maxAdultsWithChildren = raw.maxAdultsWithChildren
  const minOccupancy = raw.minOccupancy
  const minAdults = raw.minAdults
  const maxExtraBeds = raw.maxExtraBeds
  if (!whole(baseOccupancy, 1, 30) || (baseOccupancy as number) > caps.maxOccupancy) errors.push('policy.baseOccupancy: must be a whole number from 1 up to max occupancy')
  if (!whole(maxAdultsWithChildren, 0, caps.maxAdults)) errors.push('policy.maxAdultsWithChildren: must be a whole number from 0 up to max adults')
  if (!whole(minOccupancy, 1, caps.maxOccupancy)) errors.push('policy.minOccupancy: must be a whole number from 1 up to max occupancy')
  if (!whole(minAdults, 0, caps.maxAdults)) errors.push('policy.minAdults: must be a whole number from 0 up to max adults')
  else if (whole(minOccupancy, 1, caps.maxOccupancy) && (minAdults as number) > (minOccupancy as number)) errors.push('policy.minAdults: cannot be above the minimum occupancy')
  if (!whole(maxExtraBeds, 0, 6)) errors.push('policy.maxExtraBeds: must be a whole number from 0 to 6')
  if (typeof raw.extraBedCountsTowardMax !== 'boolean') errors.push('policy.extraBedCountsTowardMax: must be yes or no')
  if (typeof raw.childrenAllowed !== 'boolean') errors.push('policy.childrenAllowed: must be yes or no')
  if (typeof raw.sharingBedAllowed !== 'boolean') errors.push('policy.sharingBedAllowed: must be yes or no')
  if (typeof raw.childExtraBedAllowed !== 'boolean') errors.push('policy.childExtraBedAllowed: must be yes or no')
  if (typeof raw.adultExtraBedAllowed !== 'boolean') errors.push('policy.adultExtraBedAllowed: must be yes or no')
  if (typeof raw.lockAfterFirstBooking !== 'boolean') errors.push('policy.lockAfterFirstBooking: must be yes or no')
  let eventMaxOccupancy: number | null = null
  if (raw.eventMaxOccupancy === null) eventMaxOccupancy = null
  else if (!whole(raw.eventMaxOccupancy, caps.maxOccupancy, caps.maxOccupancy + 30)) errors.push('policy.eventMaxOccupancy: leave blank, or set a whole number at least the standard maximum and at most 30 above it')
  else eventMaxOccupancy = raw.eventMaxOccupancy as number
  const views = text(raw.views, 160, 'policy.views', errors)
  const inclusions = text(raw.inclusions, 240, 'policy.inclusions', errors)
  const description = text(raw.description, 2000, 'policy.description', errors)
  if (raw.childrenAllowed === false && caps.maxChildren !== 0) errors.push('maxChildren: must be 0 when children are not allowed')
  if (raw.childrenAllowed === true && caps.maxChildren < 1) errors.push('maxChildren: must be at least 1 when children are allowed')
  if (raw.childrenAllowed === true && whole(maxAdultsWithChildren, 0, caps.maxAdults) && whole(minAdults, 0, caps.maxAdults) && (maxAdultsWithChildren as number) < (minAdults as number)) errors.push('policy.maxAdultsWithChildren: must be at least the minimum adults when children travel')
  if (raw.sharingBedAllowed === true && raw.childrenAllowed !== true) errors.push('policy.sharingBedAllowed: sharing a bed requires children to be allowed')
  if (raw.childExtraBedAllowed === true && (!whole(maxExtraBeds, 1, 6))) errors.push('policy.childExtraBedAllowed: a child extra bed needs at least one extra bed')
  if (raw.adultExtraBedAllowed === true && (!whole(maxExtraBeds, 1, 6))) errors.push('policy.adultExtraBedAllowed: an adult extra bed needs at least one extra bed')
  const ageBands = bandProblems(raw.ageBands, raw.childrenAllowed === true, errors)
  let blocked: RoomParty[] | undefined
  if (!Array.isArray(raw.blocked) || raw.blocked.length > 80) errors.push('policy.blocked: provide at most 80 blocked combinations')
  else {
    blocked = []
    const seen = new Set<string>()
    for (const [i, entry] of raw.blocked.entries()) {
      const party = entry as { adults?: unknown; children?: unknown } | null
      if (!party || !whole(party.adults, 0, caps.maxAdults) || !whole(party.children, 0, caps.maxChildren)) { errors.push(`policy.blocked[${i}]: adults and children must sit inside the room caps`); continue }
      const key = `${party.adults}:${party.children}`
      if (seen.has(key)) { errors.push(`policy.blocked[${i}]: repeated combination`); continue }
      seen.add(key)
      blocked.push({ adults: party.adults as number, children: party.children as number })
    }
  }
  if (errors.length || !ageBands || !blocked || views === undefined || inclusions === undefined || description === undefined) return { errors }
  if (!whole(baseOccupancy, 1, 30) || !whole(maxAdultsWithChildren, 0, 30) || !whole(minOccupancy, 1, 40) || !whole(minAdults, 0, 30) || !whole(maxExtraBeds, 0, 6)) return { errors }
  const policy: RoomOccupancyPolicy = {
    baseOccupancy: baseOccupancy as number,
    views, inclusions, description,
    maxAdultsWithChildren: maxAdultsWithChildren as number,
    minOccupancy: minOccupancy as number,
    minAdults: minAdults as number,
    maxExtraBeds: maxExtraBeds as number,
    extraBedCountsTowardMax: raw.extraBedCountsTowardMax as boolean,
    eventMaxOccupancy,
    lockAfterFirstBooking: raw.lockAfterFirstBooking as boolean,
    blocked,
    childrenAllowed: raw.childrenAllowed as boolean,
    ageBands,
    sharingBedAllowed: raw.sharingBedAllowed as boolean,
    childExtraBedAllowed: raw.childExtraBedAllowed as boolean,
    adultExtraBedAllowed: raw.adultExtraBedAllowed as boolean,
  }
  return { policy, errors }
}

/** Problems with an already-typed policy. Empty means the room can be saved. */
export function policyProblems(policy: RoomOccupancyPolicy, caps: RoomOccupancyCaps): string[] {
  return normaliseOccupancyPolicy(policy, caps).errors
}

export function countedGuests(policy: Pick<RoomOccupancyPolicy, 'sharingBedAllowed'>, adults: number, children: number): number {
  const sharing = policy.sharingBedAllowed && children > 0 ? 1 : 0
  return adults + Math.max(0, children - sharing)
}

/** Why a party is or is not bookable on this room. `blocked` is an administrator override of an otherwise valid party. */
export function explainParty(policy: RoomOccupancyPolicy, caps: RoomOccupancyCaps, adults: number, children: number): { state: OccupancyCellState; reason: string } {
  if (adults === 0 && children === 0) return { state: 'invalid', reason: 'A stay needs at least one guest' }
  if (adults > caps.maxAdults) return { state: 'invalid', reason: 'Above the adult maximum' }
  if (children > caps.maxChildren) return { state: 'invalid', reason: 'Above the child maximum' }
  if (adults < policy.minAdults) return { state: 'invalid', reason: `Needs at least ${policy.minAdults} adult${policy.minAdults === 1 ? '' : 's'}` }
  if (children > 0 && adults > policy.maxAdultsWithChildren) return { state: 'invalid', reason: 'Too many adults when children travel' }
  const counted = countedGuests(policy, adults, children)
  if (counted < policy.minOccupancy) return { state: 'invalid', reason: 'Below the minimum occupancy' }
  // Base occupancy is the standard party, not a second cap. Extra beds add capacity only when they do not consume the maximum.
  const cap = policy.extraBedCountsTowardMax ? caps.maxOccupancy : caps.maxOccupancy + policy.maxExtraBeds
  if (counted > cap) return { state: 'invalid', reason: 'Above the maximum occupancy' }
  const onExtra = policy.extraBedCountsTowardMax ? 0 : Math.max(0, counted - caps.maxOccupancy)
  if (onExtra > policy.maxExtraBeds) return { state: 'invalid', reason: 'Needs more extra beds than this room allows' }
  const childrenExtra = Math.min(onExtra, Math.max(0, counted - adults))
  const adultsExtra = onExtra - childrenExtra
  if (adultsExtra > 0 && !policy.adultExtraBedAllowed) return { state: 'invalid', reason: 'An adult would need an extra bed, which this room does not offer' }
  if (childrenExtra > 0 && !policy.childExtraBedAllowed) return { state: 'invalid', reason: 'A child would need an extra bed, which this room does not offer' }
  if (policy.blocked.some((party) => party.adults === adults && party.children === children)) return { state: 'blocked', reason: 'Blocked by an administrator' }
  return { state: 'bookable', reason: 'Bookable' }
}

export function occupancyMatrix(policy: RoomOccupancyPolicy, caps: RoomOccupancyCaps): OccupancyCell[] {
  const cells: OccupancyCell[] = []
  const adultsMax = Math.min(caps.maxAdults, 12)
  const childMax = Math.min(caps.maxChildren, 8)
  for (let adults = 0; adults <= adultsMax; adults += 1) {
    for (let children = 0; children <= childMax; children += 1) {
      const explained = explainParty(policy, caps, adults, children)
      cells.push({ adults, children, ...explained })
    }
  }
  return cells
}

/** True when the next profile sells less than the one already stored. The first saved profile is not a reduction. */
export function occupancyPolicyTightened(before: RoomOccupancyPolicy | null, after: RoomOccupancyPolicy, beforeCaps: RoomOccupancyCaps, afterCaps: RoomOccupancyCaps): boolean {
  if (afterCaps.maxAdults < beforeCaps.maxAdults || afterCaps.maxChildren < beforeCaps.maxChildren || afterCaps.maxOccupancy < beforeCaps.maxOccupancy) return true
  if (!before) return false
  if (after.maxAdultsWithChildren < before.maxAdultsWithChildren) return true
  if (after.minOccupancy > before.minOccupancy || after.minAdults > before.minAdults) return true
  if (after.maxExtraBeds < before.maxExtraBeds || after.baseOccupancy < before.baseOccupancy) return true
  if (before.eventMaxOccupancy !== null && (after.eventMaxOccupancy === null || after.eventMaxOccupancy < before.eventMaxOccupancy)) return true
  if (before.childrenAllowed && !after.childrenAllowed) return true
  if (before.sharingBedAllowed && !after.sharingBedAllowed) return true
  if (before.childExtraBedAllowed && !after.childExtraBedAllowed) return true
  if (before.adultExtraBedAllowed && !after.adultExtraBedAllowed) return true
  if (!before.extraBedCountsTowardMax && after.extraBedCountsTowardMax) return true
  if (JSON.stringify(before.ageBands) !== JSON.stringify(after.ageBands)) return true
  const beforeKeys = new Set(before.blocked.map((party) => `${party.adults}:${party.children}`))
  return after.blocked.some((party) => !beforeKeys.has(`${party.adults}:${party.children}`))
}
