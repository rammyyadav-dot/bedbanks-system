import { supplementNights, supplementTerm, supplementsForPlan, supplementUnits, type SupplementRule } from './supplements'

const utc = (day: string) => new Date(`${day}T00:00:00.000Z`)
const row = (over: Partial<Parameters<typeof supplementsForPlan>[1][number]> = {}) => ({
  kind: 'BOARD', name: 'Half board', boardBasisId: 'bb', ratePlanId: null, basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: 5_000n, currency: 'AED', stayFrom: null, stayTo: null, ...over,
})

describe('board basis rules (ADR 0067)', () => {
  describe('authoring', () => {
    const board = { kind: 'BOARD', name: 'Half board', boardBasisId: 'bb-hb', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: '5000', currency: 'aed', stayFrom: '2024-02-29', stayTo: '2024-02-29' }
    it('accepts a board supplement and a compulsory one, including a leap day and a numeric amount', () => {
      const errors: string[] = []
      expect(supplementTerm(board, 's', errors)).toMatchObject({ kind: 'BOARD', currency: 'AED', amountMinor: '5000', stayFrom: '2024-02-29', boardBasisId: 'bb-hb' })
      expect(errors).toEqual([])
      expect(supplementTerm({ kind: 'COMPULSORY', name: '  Gala  ', basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: 1500, currency: 'AED' }, 's', errors)).toMatchObject({ name: 'Gala', amountMinor: '1500', boardBasisId: null, stayFrom: null, stayTo: null })
    })
    it('reports every problem, and refuses a zero amount, a non-day and a board with no board', () => {
      const errors: string[] = []
      expect(supplementTerm({ kind: 'MEAL', name: ' \u0000 ', basis: 'EACH', frequency: 'ONCE', amountMinor: '0', currency: 'US', boardBasisId: '  ', stayFrom: '2025-02-29', stayTo: '2024-01-01' }, 's', errors)).toBeNull()
      expect(errors.join(' ')).toMatch(/BOARD or COMPULSORY/)
      expect(errors.join(' ')).toMatch(/PER_ADULT/)
      expect(errors.join(' ')).toMatch(/PER_NIGHT or PER_STAY/)
      expect(errors.join(' ')).toMatch(/1 to 80/)
      expect(errors.join(' ')).toMatch(/greater than zero/)
      expect(errors.join(' ')).toMatch(/ISO-4217/)
      expect(errors.join(' ')).toMatch(/real calendar day/)
      const bare: string[] = []
      expect(supplementTerm({ kind: 'BOARD', name: 'Half board', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: '5000', currency: 'AED' }, 's', bare)).toBeNull()
      expect(bare.join(' ')).toMatch(/names the board/)
      const compulsory: string[] = []
      expect(supplementTerm({ ...board, kind: 'COMPULSORY' }, 's', compulsory)).toBeNull()
      expect(compulsory.join(' ')).toMatch(/only a board supplement/)
    })
  })

  describe('which supplements belong to a plan', () => {
    const plan = { id: 'plan-hb', boardBasisId: 'bb' }
    it('keeps this board and every compulsory supplement, and drops another board, another plan, an unknown kind and a non-positive amount', () => {
      const rules = supplementsForPlan(plan, [
        row(),
        row({ kind: 'COMPULSORY', name: 'Gala', boardBasisId: null, basis: 'PER_ROOM' }),
        row({ boardBasisId: 'bb-fb', name: 'Full board' }),
        row({ ratePlanId: 'other', name: 'Other plan' }),
        row({ kind: 'MYSTERY', name: 'Mystery' }),
        row({ amountMinor: 0n, name: 'Free' }),
        row({ amountMinor: -1n, name: 'Credit' }),
      ])
      expect(rules.map((rule) => rule.name)).toEqual(['Half board', 'Gala'])
    })
    it('keeps a supplement limited to this plan, and reads a UTC midnight as that calendar day', () => {
      const [rule] = supplementsForPlan(plan, [row({ ratePlanId: 'plan-hb', stayFrom: utc('2026-10-16'), stayTo: utc('2026-10-18') })])
      expect(rule).toMatchObject({ stayFrom: '2026-10-16', stayTo: '2026-10-18' })
    })
    it('drops a supplement whose window cannot be read, instead of applying it to every night', () => {
      expect(supplementsForPlan(plan, [row({ stayFrom: new Date(Number.NaN) })])).toEqual([])
      expect(supplementsForPlan(plan, [row({ stayTo: new Date(Number.NaN) })])).toEqual([])
    })
  })

  describe('charging the party', () => {
    const nights = ['2026-10-15', '2026-10-16', '2026-10-17']
    const rule = (over: Partial<SupplementRule>): SupplementRule => ({ name: 'Half board', kind: 'BOARD', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: 1_000n, currency: 'AED', stayFrom: null, stayTo: null, ...over })
    it('charges a per-stay supplement once, on the first night inside the window, and stacks a per-night board', () => {
      const charged = supplementNights([
        rule({ name: 'Gala', kind: 'COMPULSORY', basis: 'PER_PERSON', frequency: 'PER_STAY', amountMinor: 2_000n, stayFrom: '2026-10-16', stayTo: '2026-10-17' }),
        rule({ amountMinor: 500n }),
      ], nights, { adults: 2, children: 1 })
      // Gala: 2 adults + 1 child = 3, once, on 16 Oct. Half board: 500 x 2 adults x 3 nights.
      expect(charged.perNight).toEqual([1_000n, 6_000n + 1_000n, 1_000n])
      expect(charged.applied).toEqual([{ name: 'Gala', kind: 'COMPULSORY', amountMinor: 6_000n }, { name: 'Half board', kind: 'BOARD', amountMinor: 3_000n }])
    })
    it('includes both ends of the window and skips a window or a party that counts nobody', () => {
      expect(supplementNights([rule({ stayFrom: '2026-10-17', stayTo: '2026-10-17' })], nights, { adults: 2, children: 0 }).perNight).toEqual([0n, 0n, 2_000n])
      expect(supplementNights([rule({ stayFrom: '2026-12-01', stayTo: '2026-12-02' })], nights, { adults: 2, children: 0 }).applied).toEqual([])
      expect(supplementNights([rule({ basis: 'PER_CHILD' })], nights, { adults: 2, children: 0 }).applied).toEqual([])
      expect(supplementNights([rule({ amountMinor: 0n })], nights, { adults: 2, children: 0 }).applied).toEqual([])
    })
    it('a fractional or negative party does not throw and adds nothing', () => {
      expect(supplementUnits('PER_ADULT', { adults: 2.5, children: 0 })).toBe(0n)
      expect(supplementUnits('PER_PERSON', { adults: 2, children: -1 })).toBe(0n)
      expect(supplementUnits('PER_ROOM', { adults: 2.5, children: 0 })).toBe(1n)
      expect(() => supplementNights([rule({})], nights, { adults: 2.5, children: 0 })).not.toThrow()
      expect(supplementNights([rule({})], nights, { adults: 2.5, children: 0 }).applied).toEqual([])
    })
  })
})
