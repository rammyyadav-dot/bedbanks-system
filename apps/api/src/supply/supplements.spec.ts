import { supplementNights, supplementTerm, supplementsForPlan, type SupplementRule } from './supplements'

const day = (iso: string | null) => (iso === null ? null : new Date(`${iso}T00:00:00.000Z`))

const row = (over: Partial<{ kind: string; name: string; boardBasisId: string | null; ratePlanId: string | null; basis: string; frequency: string; amountMinor: bigint; currency: string; stayFrom: Date | null; stayTo: Date | null }> = {}) => ({
  kind: 'BOARD', name: 'Breakfast', boardBasisId: 'bb', ratePlanId: null, basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: 4_000n, currency: 'AED', stayFrom: null, stayTo: null, ...over,
})

describe('board-basis inheritance (ADR 0067)', () => {
  const breakfast = row()
  const halfBoard = row({ name: 'Half board', boardBasisId: 'hb', amountMinor: 9_000n })
  const otherPlan = row({ name: 'Other breakfast', ratePlanId: 'plan-2' })
  const thisPlan = row({ name: 'Plan breakfast', ratePlanId: 'plan-1', amountMinor: 1_500n })
  const gala = row({ kind: 'COMPULSORY', name: 'Gala dinner', boardBasisId: null, basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: 6_000n, stayFrom: day('2026-12-24'), stayTo: day('2026-12-26') })
  const unknown = row({ kind: 'TAX', name: 'City tax' })

  it('a plan inherits its own board and every compulsory supplement, and nothing for another board or plan', () => {
    const inherited = supplementsForPlan({ id: 'plan-1', boardBasisId: 'bb' }, [halfBoard, otherPlan, unknown, breakfast, thisPlan, gala])
    expect(inherited.map((rule) => rule.name)).toEqual(['Breakfast', 'Plan breakfast', 'Gala dinner'])
    expect(inherited[0]).toEqual({ name: 'Breakfast', kind: 'BOARD', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: 4_000n, currency: 'AED', stayFrom: null, stayTo: null })
    expect(inherited[2]).toMatchObject({ kind: 'COMPULSORY', stayFrom: '2026-12-24', stayTo: '2026-12-26', amountMinor: 6_000n })
  })

  it('a different board inherits that board only, and a compulsory row still applies even when it names a board', () => {
    const misfiled = row({ kind: 'COMPULSORY', name: 'Misfiled', boardBasisId: 'hb' })
    expect(supplementsForPlan({ id: 'plan-1', boardBasisId: 'hb' }, [breakfast, halfBoard, misfiled]).map((rule) => rule.name)).toEqual(['Half board', 'Misfiled'])
    expect(supplementsForPlan({ id: 'plan-1', boardBasisId: 'ro' }, [breakfast, halfBoard, gala]).map((rule) => rule.name)).toEqual(['Gala dinner'])
  })

  it('a board row with no board, and a plan-scoped row for someone else, are not inherited', () => {
    const unnamed = row({ boardBasisId: null, name: 'Unnamed board' })
    expect(supplementsForPlan({ id: 'plan-1', boardBasisId: 'bb' }, [unnamed, otherPlan])).toEqual([])
  })

  it('keeps the amount as a bigint and reads stay dates as UTC calendar days', () => {
    const shifted = row({ stayFrom: new Date('2026-10-16T00:00:00+04:00'), stayTo: new Date('2026-10-16T23:00:00.000Z'), amountMinor: 9_007_199_254_740_993n })
    const [rule] = supplementsForPlan({ id: 'plan-1', boardBasisId: 'bb' }, [shifted])
    expect(rule).toMatchObject({ stayFrom: '2026-10-15', stayTo: '2026-10-16', amountMinor: 9_007_199_254_740_993n })
    expect(typeof rule!.amountMinor).toBe('bigint')
  })
})

const rule = (over: Partial<SupplementRule> = {}): SupplementRule => ({
  name: 'Breakfast', kind: 'BOARD', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: 4_000n, currency: 'AED', stayFrom: null, stayTo: null, ...over,
})
const nights = ['2026-10-15', '2026-10-16', '2026-10-17']
const party = { adults: 2, children: 1 }

describe('seasonal supplement windows', () => {
  it('charges an open, a closed and a one-sided window on the inclusive nights only', () => {
    const open = supplementNights([rule()], nights, party)
    expect(open.perNight).toEqual([8_000n, 8_000n, 8_000n])
    const closed = supplementNights([rule({ stayFrom: '2026-10-16', stayTo: '2026-10-16' })], nights, party)
    expect(closed.perNight).toEqual([0n, 8_000n, 0n])
    expect(closed.applied).toEqual([{ name: 'Breakfast', kind: 'BOARD', amountMinor: 8_000n }])
    expect(supplementNights([rule({ stayFrom: '2026-10-16', stayTo: null })], nights, party).perNight).toEqual([0n, 8_000n, 8_000n])
    expect(supplementNights([rule({ stayFrom: null, stayTo: '2026-10-15' })], nights, party).perNight).toEqual([8_000n, 0n, 0n])
  })

  it('charges a per-stay supplement once, on the first night inside its window', () => {
    const gala = rule({ name: 'Gala dinner', kind: 'COMPULSORY', basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: 6_000n, stayFrom: '2026-10-16', stayTo: '2026-10-17' })
    const priced = supplementNights([gala], nights, party)
    expect(priced.perNight).toEqual([0n, 6_000n, 0n])
    expect(priced.applied).toEqual([{ name: 'Gala dinner', kind: 'COMPULSORY', amountMinor: 6_000n }])
  })

  it('counts the party by basis and skips a supplement that counts nobody', () => {
    expect(supplementNights([rule({ basis: 'PER_PERSON' })], nights, party).perNight).toEqual([12_000n, 12_000n, 12_000n])
    expect(supplementNights([rule({ basis: 'PER_CHILD', amountMinor: 3_000n })], nights, party).perNight).toEqual([3_000n, 3_000n, 3_000n])
    expect(supplementNights([rule({ basis: 'PER_ROOM', amountMinor: 7_000n })], nights, party).perNight).toEqual([7_000n, 7_000n, 7_000n])
    const noChild = supplementNights([rule({ basis: 'PER_CHILD' })], nights, { adults: 2, children: 0 })
    expect(noChild).toEqual({ perNight: [0n, 0n, 0n], applied: [] })
    expect(supplementNights([rule({ basis: 'PER_ADULT' })], nights, { adults: 2, children: 0 }).applied[0]!.amountMinor).toBe(24_000n)
  })

  it('stacks overlapping seasons and does not double-charge adjacent ones', () => {
    const early = rule({ name: 'Shoulder', amountMinor: 1_000n, stayTo: '2026-10-16' })
    const peak = rule({ name: 'Peak', amountMinor: 2_000n, stayFrom: '2026-10-16' })
    const stacked = supplementNights([early, peak], nights, { adults: 2, children: 0 })
    expect(stacked.perNight).toEqual([2_000n, 6_000n, 4_000n])
    expect(stacked.applied.map((item) => item.amountMinor)).toEqual([4_000n, 8_000n])
    const next = rule({ name: 'Next', amountMinor: 2_000n, stayFrom: '2026-10-17' })
    expect(supplementNights([rule({ name: 'Until', amountMinor: 1_000n, stayTo: '2026-10-16' }), next], nights, { adults: 1, children: 0 }).perNight).toEqual([1_000n, 1_000n, 2_000n])
  })

  it('a window that misses the stay, or a stay with no nights, adds nothing', () => {
    expect(supplementNights([rule({ stayFrom: '2026-12-24', stayTo: '2026-12-26' })], nights, party)).toEqual({ perNight: [0n, 0n, 0n], applied: [] })
    expect(supplementNights([rule()], [], party)).toEqual({ perNight: [], applied: [] })
  })

  it('keeps a large per-night amount exact', () => {
    const huge = rule({ basis: 'PER_ROOM', amountMinor: 9_007_199_254_740_993n, frequency: 'PER_STAY', stayFrom: '2026-10-17', stayTo: '2026-10-17' })
    expect(supplementNights([huge], nights, party).perNight).toEqual([0n, 0n, 9_007_199_254_740_993n])
  })
})

describe('supplement terms', () => {
  const board = { kind: 'BOARD', name: ' Breakfast ', boardBasisId: ' bb ', ratePlanId: '', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: '4000', currency: ' aed ', stayFrom: '', stayTo: null }

  it('normalises a board supplement and a numeric amount', () => {
    const errors: string[] = []
    expect(supplementTerm(board, 'supplements[0]', errors)).toEqual({
      kind: 'BOARD', name: 'Breakfast', boardBasisId: 'bb', ratePlanId: null, basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: '4000', currency: 'AED', stayFrom: null, stayTo: null,
    })
    expect(errors).toEqual([])
    expect(supplementTerm({ ...board, amountMinor: 25050, kind: 'COMPULSORY', boardBasisId: null }, 's', [])?.amountMinor).toBe('25050')
  })

  it('reports every problem and returns nothing', () => {
    const errors: string[] = []
    expect(supplementTerm({
      kind: 'TAX', name: ' \u0000 ', boardBasisId: '   ', basis: 'PER_BED', frequency: 'ONCE', amountMinor: '0', currency: 'aed1', stayFrom: '2026-02-30', stayTo: '2026-01-01',
    }, 'supplements[1]', errors)).toBeNull()
    expect(errors.join(' ')).toMatch(/BOARD or COMPULSORY/)
    expect(errors.join(' ')).toMatch(/PER_ADULT/)
    expect(errors.join(' ')).toMatch(/PER_NIGHT or PER_STAY/)
    expect(errors.join(' ')).toMatch(/1 to 80/)
    expect(errors.join(' ')).toMatch(/greater than zero/)
    expect(errors.join(' ')).toMatch(/ISO-4217/)
    expect(errors.join(' ')).toMatch(/2026-02-30|real calendar day/)
    expect(errors.join(' ')).toMatch(/real calendar day/)
  })

  it('a board supplement must name its board, and a compulsory one must not', () => {
    const missing: string[] = []
    expect(supplementTerm({ ...board, boardBasisId: '  ' }, 's', missing)).toBeNull()
    expect(missing.join(' ')).toMatch(/names the board/)
    const named: string[] = []
    expect(supplementTerm({ ...board, kind: 'COMPULSORY', boardBasisId: 'bb' }, 's', named)).toBeNull()
    expect(named.join(' ')).toMatch(/only a board supplement/)
  })

  it('refuses an inverted window, a leading-zero amount and a non-object', () => {
    const inverted: string[] = []
    expect(supplementTerm({ ...board, stayFrom: '2026-10-17', stayTo: '2026-10-16' }, 's', inverted)).toBeNull()
    expect(inverted.join(' ')).toMatch(/on or after/)
    const padded: string[] = []
    expect(supplementTerm({ ...board, amountMinor: '04000' }, 's', padded)).toBeNull()
    expect(padded.join(' ')).toMatch(/greater than zero/)
    expect(supplementTerm(null, 's', [])).toBeNull()
    expect(supplementTerm({ ...board, amountMinor: 1.5 }, 's', [])).toBeNull()
  })
})
