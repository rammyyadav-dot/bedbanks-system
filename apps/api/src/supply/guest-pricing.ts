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
export interface GuestPriceLine { kind: GuestPriceKind; minAge: number; maxAge: number; amountMinor: bigint; basis: 'NET' | 'SELL'; currency: string }
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
  if (!Number.isInteger(input.adults) || !Number.isInteger(input.children) || input.adults < input.planOccupancy || input.children < 0
    || input.adults > limits.maxAdults || input.children > limits.maxChildren || guests > limits.maxOccupancy) reasons.add('OCCUPANCY_UNSUPPORTED')
  if (lines.some((line) => line.currency !== input.currency)) reasons.add('GUEST_PRICE_CURRENCY_MISMATCH')

  let extra = 0n
  const used = new Set<'NET' | 'SELL'>()
  const extraAdults = input.adults - input.planOccupancy
  if (extraAdults > 0) {
    const adultLines = lines.filter((line) => line.kind === 'EXTRA_ADULT')
    if (adultLines.length !== 1) reasons.add('EXTRA_ADULT_PRICE_MISSING')
    else { extra += adultLines[0]!.amountMinor * BigInt(extraAdults); used.add(adultLines[0]!.basis) }
  }
  if (input.children > 0) {
    const ages = input.childAges ?? []
    if (ages.length !== input.children || ages.some((age) => !Number.isInteger(age) || age < 0 || age > 17)) reasons.add('CHILD_AGES_REQUIRED')
    else for (const age of ages) {
      const matches = lines.filter((line) => line.kind === 'CHILD' && age >= line.minAge && age <= line.maxAge)
      if (matches.length === 0) reasons.add('CHILD_AGE_NOT_COVERED')
      else if (matches.length > 1) reasons.add('CHILD_PRICE_AMBIGUOUS')
      else { extra += matches[0]!.amountMinor; used.add(matches[0]!.basis) }
    }
  }
  if (used.size > 1) reasons.add('GUEST_PRICE_BASIS_MIXED')
  return { mode: 'LINES', reasons: [...reasons], extraMinorPerNight: reasons.size ? 0n : extra, basis: used.size === 1 ? [...used][0]! : null }
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
