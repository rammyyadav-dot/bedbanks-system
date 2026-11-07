import type { RoomOccupancyPolicy } from '@bedbanks/contracts'

/**
 * Child and extra-adult pricing for a rate plan (ADR 0057, S6). Pure: no I/O.
 *
 * A plan's nightly rate is for its BASE party: `occupancy` adults (finding F12: `RatePlan.occupancy` is authoritative and `DailyRate.occupancy`
 * always equals it; pax-mix pricing is lines on top, not more rate rows). A plan with NO guest price lines keeps the original rule untouched:
 * adults plus children must equal `occupancy` and the stay is priced at the flat nightly rate. A plan WITH lines is priced per night as
 * base rate + one line per extra adult + one child line per child chosen by that child's age.
 *
 * Nothing is guessed. A child whose age no line covers, a missing age, an ambiguous band, an extra adult with no price, a party the room cannot
 * hold, lines in a different currency or basis than the rate: each is a typed reason that makes the offer unsellable. A line of zero is an
 * explicit free guest; it is never what a missing line means.
 */
export type GuestPriceKind = 'CHILD' | 'EXTRA_ADULT'
/**
 * One price line. `basis` INHERIT marks a band inherited from the contract child policy (ADR 0067, F-03): it is charged on the same basis as the
 * night's rate. `amountMinor` null marks an inherited band whose contract recorded no supplement: a child who must be charged by it is refused.
 */
export interface GuestPriceLine { kind: GuestPriceKind; minAge: number; maxAge: number; amountMinor: bigint | null; basis: 'NET' | 'SELL' | 'INHERIT'; currency: string }
export interface GuestRoomLimits { maxAdults: number; maxChildren: number; maxOccupancy: number }

/** The sentinel band stored for the single EXTRA_ADULT line, so the database can keep one per plan with an ordinary unique key. */
export const EXTRA_ADULT_BAND = { minAge: 18, maxAge: 99 } as const
export const MAX_GUEST_PRICE = 9_000_000_000_000_000n

export type GuestPricing =
  | { mode: 'FLAT'; reasons: string[] }
  | { mode: 'LINES'; reasons: string[]; extraMinorPerNight: bigint; basis: 'NET' | 'SELL' | null }

export interface GuestPricingInput {
  planOccupancy: number; currency: string
  adults: number; children: number; childAges?: readonly number[]
  lines: readonly GuestPriceLine[]; limits: GuestRoomLimits
}

export function resolveGuestPricing(input: GuestPricingInput): GuestPricing {
  const { lines, limits } = input
  if (lines.length === 0) {
    // Original behaviour, kept exactly: the party size must equal the plan occupancy.
    const guests = input.adults + input.children
    const bad = guests !== input.planOccupancy || input.adults > limits.maxAdults || input.children > limits.maxChildren || guests > limits.maxOccupancy
    return { mode: 'FLAT', reasons: bad ? ['OCCUPANCY_UNSUPPORTED'] : [] }
  }
  const reasons = new Set<string>()
  const guests = input.adults + input.children
  // The base rate is for `planOccupancy` guests. Children may fill base places adults leave empty (1 adult + 1 child in a double pays the double
  // rate, ADR 0067 F-03); the party must still fill the base and fit the room, with at least one adult.
  // Safe integers only: a fractional adult count must be a typed refusal, never a BigInt throw mid-price.
  if (!Number.isSafeInteger(input.adults) || !Number.isSafeInteger(input.children) || input.adults < 1 || input.children < 0 || guests < input.planOccupancy
    || input.adults > limits.maxAdults || input.children > limits.maxChildren || guests > limits.maxOccupancy) reasons.add('OCCUPANCY_UNSUPPORTED')
  if (lines.some((line) => line.currency !== input.currency)) reasons.add('GUEST_PRICE_CURRENCY_MISMATCH')

  let extra = 0n
  const used = new Set<'NET' | 'SELL'>()
  const charge = (line: GuestPriceLine, units = 1n) => { if (line.amountMinor === null) { reasons.add('CHILD_PRICE_MISSING'); return } extra += line.amountMinor * units; if (line.basis !== 'INHERIT') used.add(line.basis) }
  const extraAdults = input.adults - input.planOccupancy
  if (Number.isSafeInteger(extraAdults) && extraAdults > 0) {
    const adultLines = lines.filter((line) => line.kind === 'EXTRA_ADULT')
    if (adultLines.length !== 1) reasons.add('EXTRA_ADULT_PRICE_MISSING')
    else charge(adultLines[0]!, BigInt(extraAdults))
  }
  if (input.children > 0) {
    const ages = input.childAges ?? []
    if (ages.length !== input.children || ages.some((age) => !Number.isInteger(age) || age < 0 || age > 17)) reasons.add('CHILD_AGES_REQUIRED')
    else {
      // The oldest children take the base places left by adults; only the rest are charged as extra guests.
      const basePlaces = Math.max(0, input.planOccupancy - input.adults)
      for (const age of [...ages].sort((a, b) => b - a).slice(basePlaces)) {
        const matches = lines.filter((line) => line.kind === 'CHILD' && age >= line.minAge && age <= line.maxAge)
        if (matches.length === 0) reasons.add('CHILD_AGE_NOT_COVERED')
        else if (matches.length > 1) reasons.add('CHILD_PRICE_AMBIGUOUS')
        else charge(matches[0]!)
      }
    }
  }
  if (used.size > 1) reasons.add('GUEST_PRICE_BASIS_MIXED')
  return { mode: 'LINES', reasons: [...reasons], extraMinorPerNight: reasons.size ? 0n : extra, basis: used.size === 1 ? [...used][0]! : null }
}

/**
 * The lines that price a plan's party (ADR 0067, F-03): the plan's own lines; and when the plan has no CHILD line of its own, the contract's child
 * bands, inherited with basis INHERIT. One child policy therefore governs a plan: its own when it has one, the contract's otherwise.
 */
export function effectiveGuestLines(planLines: readonly GuestPriceLine[], contractBands: ReadonlyArray<{ minAge: number; maxAge: number; supplementMinor: bigint | null; currency: string | null }>, planCurrency: string): GuestPriceLine[] {
  if (planLines.some((line) => line.kind === 'CHILD')) return [...planLines]
  return [...planLines, ...contractBands.map((band): GuestPriceLine => ({ kind: 'CHILD', minAge: band.minAge, maxAge: band.maxAge, amountMinor: band.supplementMinor, basis: 'INHERIT', currency: band.currency ?? planCurrency }))]
}

export interface GuestPriceLineIssue { code: string; message: string }

/** Validates a plan's whole set of lines on write. Returns every problem, so the operator fixes them in one pass. */
export function validateGuestPriceLines(lines: ReadonlyArray<{ kind: string; minAge?: number; maxAge?: number; amountMinor?: bigint | null; basis?: string; currency?: string }>, planCurrency: string): GuestPriceLineIssue[] {
  const issues: GuestPriceLineIssue[] = []
  const children: Array<{ min: number; max: number }> = []
  let extraAdultLines = 0
  lines.forEach((line, i) => {
    const at = `Line ${i + 1}`
    if (line.kind !== 'CHILD' && line.kind !== 'EXTRA_ADULT') return void issues.push({ code: 'GUEST_PRICE_KIND_INVALID', message: `${at}: kind must be CHILD or EXTRA_ADULT.` })
    if (line.basis !== 'NET' && line.basis !== 'SELL') issues.push({ code: 'GUEST_PRICE_BASIS_INVALID', message: `${at}: basis must be NET or SELL.` })
    if (line.currency !== planCurrency) issues.push({ code: 'GUEST_PRICE_CURRENCY_MISMATCH', message: `${at}: currency must be the plan currency ${planCurrency}.` })
    if (typeof line.amountMinor !== 'bigint' || line.amountMinor < 0n || line.amountMinor > MAX_GUEST_PRICE) issues.push({ code: 'GUEST_PRICE_AMOUNT_INVALID', message: `${at}: amount must be a whole number of minor units, zero or more (zero is an explicit free guest).` })
    if (line.kind === 'EXTRA_ADULT') extraAdultLines += 1
    else {
      const min = line.minAge, max = line.maxAge
      if (!Number.isInteger(min) || !Number.isInteger(max) || min! < 0 || max! > 17 || max! < min!) issues.push({ code: 'GUEST_PRICE_AGE_BAND_INVALID', message: `${at}: a child band needs whole ages 0 to 17 with the maximum not below the minimum.` })
      else children.push({ min: min!, max: max! })
    }
  })
  if (extraAdultLines > 1) issues.push({ code: 'GUEST_PRICE_EXTRA_ADULT_DUPLICATE', message: 'At most one extra-adult line per plan.' })
  const sorted = [...children].sort((a, b) => a.min - b.min)
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.min <= sorted[i - 1]!.max) { issues.push({ code: 'GUEST_PRICE_AGE_BANDS_OVERLAP', message: `Child bands ${sorted[i - 1]!.min}-${sorted[i - 1]!.max} and ${sorted[i]!.min}-${sorted[i]!.max} overlap; a child must match exactly one.` }); break }
  return issues
}

/** One adult's share of a night sold for `planOccupancy` adults. Half up, integer minor units only. */
export function perAdultShare(nightlyMinor: bigint, planOccupancy: number): bigint {
  if (nightlyMinor < 0n || !Number.isSafeInteger(planOccupancy) || planOccupancy < 1) return 0n
  const divisor = BigInt(planOccupancy)
  return (nightlyMinor + divisor / 2n) / divisor
}

/**
 * Extra charge for one night from the room's age bands (ADR 0114). Used only when the plan has no CHILD lines of its own, so a contract
 * supplement is not added as well. The oldest children fill base places the adults left empty and pay nothing extra. A sharing child, the
 * youngest, is not charged. FREE is an explicit zero. PERCENT is that many basis points of one adult's share of this night. An age that
 * falls in the adult band pays a full adult share. A missing age or band is refused and contributes no amount.
 */
export function roomPolicyNightExtra(input: { policy: RoomOccupancyPolicy; nightlyMinor: bigint; planOccupancy: number; adults: number; children: number; childAges?: readonly number[] }): { extraMinor: bigint; reasons: string[] } {
  if (input.children === 0) return { extraMinor: 0n, reasons: [] }
  const ages = input.childAges ?? []
  if (ages.length !== input.children || ages.some((age) => !Number.isInteger(age) || age < 0 || age > 17)) return { extraMinor: 0n, reasons: ['CHILD_AGES_REQUIRED'] }
  let remaining = [...ages]
  if (input.policy.sharingBedAllowed) {
    const youngest = Math.min(...remaining)
    remaining.splice(remaining.indexOf(youngest), 1)
  }
  const basePlaces = Math.max(0, input.planOccupancy - input.adults)
  const extras = remaining.sort((a, b) => b - a).slice(basePlaces)
  const share = perAdultShare(input.nightlyMinor, input.planOccupancy)
  const reasons = new Set<string>()
  let extra = 0n
  for (const age of extras) {
    const band = input.policy.ageBands.find((item) => age >= item.minAge && age <= item.maxAge)
    if (!band) { reasons.add('CHILD_AGE_NOT_COVERED'); continue }
    if (band.kind === 'ADULT') { extra += share; continue }
    if (band.charge === 'FREE') continue
    if (band.percentBp === null) { reasons.add('CHILD_PRICE_MISSING'); continue }
    extra += (share * BigInt(band.percentBp) + 5_000n) / 10_000n
  }
  return { extraMinor: reasons.size ? 0n : extra, reasons: [...reasons] }
}
