/**
 * Board and compulsory supplements on a contract (ADR 0067). Pure: no I/O, integer minor units only.
 *
 * A BOARD supplement prices the plans sold on its board; a COMPULSORY supplement (a gala dinner, a festive surcharge) applies to every plan of the
 * contract. Either may be limited to one plan and to a window of stay nights. The evaluator adds them per room after the promotion and before the
 * markup, so a promotion never discounts them and a NET rate's supplement is marked up like the rate.
 */
export const SUPPLEMENT_KINDS = ['BOARD', 'COMPULSORY'] as const
export const SUPPLEMENT_BASES = ['PER_ADULT', 'PER_CHILD', 'PER_PERSON', 'PER_ROOM'] as const
export const SUPPLEMENT_FREQUENCIES = ['PER_NIGHT', 'PER_STAY'] as const
export const MAX_SUPPLEMENTS = 30

export type SupplementKind = (typeof SUPPLEMENT_KINDS)[number]
export type SupplementBasis = (typeof SUPPLEMENT_BASES)[number]
export type SupplementFrequency = (typeof SUPPLEMENT_FREQUENCIES)[number]

/** As stored and reviewed. Amounts are minor units as decimal strings; dates are stay nights, YYYY-MM-DD, inclusive. */
export interface SupplementTerm {
  kind: SupplementKind; name: string; boardBasisId: string | null; ratePlanId: string | null
  basis: SupplementBasis; frequency: SupplementFrequency; amountMinor: string; currency: string; stayFrom: string | null; stayTo: string | null
}

/** A supplement that applies to one plan, as the evaluator reads it. */
export interface SupplementRule { name: string; kind: SupplementKind; basis: SupplementBasis; frequency: SupplementFrequency; amountMinor: bigint; currency: string; stayFrom: string | null; stayTo: string | null }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const MINOR = /^[1-9][0-9]{0,15}$/

/** Validates one supplement as the create endpoint and amendments do. Pushes every problem; returns the normalised term or null. */
export function supplementTerm(raw: unknown, at: string, errors: string[]): SupplementTerm | null {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const before = errors.length
  const kind = r.kind as SupplementKind
  const basis = r.basis as SupplementBasis
  const frequency = r.frequency as SupplementFrequency
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const amount = typeof r.amountMinor === 'string' ? r.amountMinor : typeof r.amountMinor === 'number' && Number.isSafeInteger(r.amountMinor) ? String(r.amountMinor) : ''
  const currency = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : ''
  const boardBasisId = typeof r.boardBasisId === 'string' && r.boardBasisId.trim() ? r.boardBasisId.trim() : null
  const ratePlanId = typeof r.ratePlanId === 'string' && r.ratePlanId.trim() ? r.ratePlanId.trim() : null
  const stayFrom = r.stayFrom === undefined || r.stayFrom === null || r.stayFrom === '' ? null : r.stayFrom
  const stayTo = r.stayTo === undefined || r.stayTo === null || r.stayTo === '' ? null : r.stayTo
  if (!(SUPPLEMENT_KINDS as readonly string[]).includes(kind)) errors.push(`${at}.kind: BOARD or COMPULSORY.`)
  if (!(SUPPLEMENT_BASES as readonly string[]).includes(basis)) errors.push(`${at}.basis: one of ${SUPPLEMENT_BASES.join(', ')}.`)
  if (!(SUPPLEMENT_FREQUENCIES as readonly string[]).includes(frequency)) errors.push(`${at}.frequency: PER_NIGHT or PER_STAY.`)
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f]/.test(name)) errors.push(`${at}.name: 1 to 80 characters.`)
  if (!MINOR.test(amount)) errors.push(`${at}.amountMinor: a whole number of minor units, greater than zero.`)
  if (!/^[A-Z]{3}$/.test(currency)) errors.push(`${at}.currency: a 3-letter ISO-4217 code.`)
  if (kind === 'BOARD' && boardBasisId === null) errors.push(`${at}.boardBasisId: a board supplement names the board it prices.`)
  if (kind === 'COMPULSORY' && boardBasisId !== null) errors.push(`${at}.boardBasisId: only a board supplement names a board.`)
  if (stayFrom !== null && !isDay(stayFrom)) errors.push(`${at}.stayFrom: a real calendar day (YYYY-MM-DD), or empty.`)
  if (stayTo !== null && !isDay(stayTo)) errors.push(`${at}.stayTo: a real calendar day (YYYY-MM-DD), or empty.`)
  if (isDay(stayFrom) && isDay(stayTo) && stayTo < stayFrom) errors.push(`${at}.stayTo: on or after stayFrom.`)
  if (errors.length > before) return null
  return { kind, name, boardBasisId, ratePlanId, basis, frequency, amountMinor: amount, currency, stayFrom: stayFrom as string | null, stayTo: stayTo as string | null }
}

/** The supplements of a contract that apply to this plan: its board's BOARD supplements and every COMPULSORY one, each optionally limited to the plan. */
export function supplementsForPlan(plan: { id: string; boardBasisId: string }, rows: ReadonlyArray<{ kind: string; name: string; boardBasisId: string | null; ratePlanId: string | null; basis: string; frequency: string; amountMinor: bigint; currency: string; stayFrom: Date | null; stayTo: Date | null }>): SupplementRule[] {
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  return rows
    .filter((row) => (row.ratePlanId === null || row.ratePlanId === plan.id) && (row.kind === 'COMPULSORY' || (row.kind === 'BOARD' && row.boardBasisId === plan.boardBasisId)))
    .map((row) => ({ name: row.name, kind: row.kind as SupplementKind, basis: row.basis as SupplementBasis, frequency: row.frequency as SupplementFrequency, amountMinor: row.amountMinor, currency: row.currency, stayFrom: day(row.stayFrom), stayTo: day(row.stayTo) }))
}

/** How many units (adults, children, people or rooms) a PER_ADULT/PER_CHILD/PER_PERSON/PER_ROOM amount counts for this party. Shared with event supplements (ADR 0089). */
export const supplementUnits = (basis: SupplementBasis, party: { adults: number; children: number }): bigint =>
  BigInt(basis === 'PER_ADULT' ? party.adults : basis === 'PER_CHILD' ? party.children : basis === 'PER_PERSON' ? party.adults + party.children : 1)
const units = supplementUnits

/**
 * Per room, the amount each night carries and the supplements that applied. A PER_STAY supplement is charged once, on the first stay night in
 * its window; PER_NIGHT on every night in it. A supplement whose window misses the stay, or that counts nobody (PER_CHILD with no child), is not applied.
 */
export function supplementNights(rules: readonly SupplementRule[], nights: readonly string[], party: { adults: number; children: number }): { perNight: bigint[]; applied: Array<{ name: string; kind: SupplementKind; amountMinor: bigint }> } {
  const perNight = nights.map(() => 0n)
  const applied: Array<{ name: string; kind: SupplementKind; amountMinor: bigint }> = []
  for (const rule of rules) {
    const count = units(rule.basis, party)
    if (count === 0n) continue
    const inWindow = nights.map((night, i) => ((rule.stayFrom === null || night >= rule.stayFrom) && (rule.stayTo === null || night <= rule.stayTo) ? i : -1)).filter((i) => i >= 0)
    if (inWindow.length === 0) continue
    const charged = rule.frequency === 'PER_STAY' ? [inWindow[0]!] : inWindow
    for (const i of charged) perNight[i] = perNight[i]! + rule.amountMinor * count
    applied.push({ name: rule.name, kind: rule.kind, amountMinor: rule.amountMinor * count * BigInt(charged.length) })
  }
  return { perNight, applied }
}
