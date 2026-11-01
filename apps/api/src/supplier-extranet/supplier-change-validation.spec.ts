import type { ImportPlan } from '../supply/calendar-import'
import { cellsSha256, validateSupplierCsv } from './supplier-change-validation'

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({ id: 'rp1', code: 'RACK', currency: 'AED', occupancy: 2, maxOccupancy: 3, inventoryPoolId: null, contractValidFrom: '2099-01-01', contractValidTo: '2099-12-31', ...over })
const none = new Map()
const header = 'plan_code,date,allotment,stop_sell,min_stay,release_days'

describe('supplier availability CSV validation (ADR 0061 Amendment 3)', () => {
  it('accepts a valid file and returns availability cells with the plan code', () => {
    const report = validateSupplierCsv(`${header}\nRACK,2099-03-01,5,false,2,3\nRACK,2099-03-02,0,true,1,`, [plan()], none)
    expect(report).toMatchObject({ ok: true, fatal: [], errors: [] })
    expect(report.cells).toEqual([
      { ratePlanId: 'rp1', ratePlanCode: 'RACK', stayDate: '2099-03-01', allotment: 5, stopSell: false, minStay: 2, releaseDays: 3, expectedUpdatedAt: null },
      { ratePlanId: 'rp1', ratePlanCode: 'RACK', stayDate: '2099-03-02', allotment: 0, stopSell: true, minStay: 1, releaseDays: null, expectedUpdatedAt: null },
    ])
  })

  it.each(['amount', 'basis', 'currency'])('refuses a %s column: rates are not accepted in this slice', (column) => {
    const report = validateSupplierCsv(`plan_code,date,allotment,${column}\nRACK,2099-03-01,5,NET`, [plan()], none)
    expect(report.ok).toBe(false)
    expect(report.fatal[0]).toMatchObject({ code: 'RATES_NOT_ACCEPTED', field: column })
    expect(report.cells).toEqual([])
  })

  it('refuses a plan that draws from a shared inventory pool, naming it', () => {
    const report = validateSupplierCsv(`${header}\nPOOL,2099-03-01,5,false,1,`, [plan({ id: 'rp2', code: 'POOL', inventoryPoolId: 'pool1' })], none)
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([expect.objectContaining({ code: 'POOLED_PLAN', message: expect.stringContaining('POOL') })])
    expect(report.cells).toEqual([])
  })

  it('reports a plan the organization does not own as not found, never as forbidden', () => {
    const report = validateSupplierCsv(`${header}\nOTHER-ORG-PLAN,2099-03-01,5,false,1,`, [plan()], none)
    expect(report.ok).toBe(false)
    expect(report.errors[0]).toMatchObject({ line: 2, code: 'PLAN_NOT_FOUND' })
    expect(JSON.stringify(report)).not.toMatch(/forbidden|not allowed|permission/i)
  })

  it('applies the staff rules: outside the contract term, below committed inventory', () => {
    const existing = new Map([['rp1|2099-03-01', { updatedAt: '2099-01-01T00:00:00.000Z', allotment: 10, sold: 4, held: 2, stopSell: false, minStay: 1, releaseDays: null }]])
    const report = validateSupplierCsv(`${header}\nRACK,2100-01-01,5,false,1,\nRACK,2099-03-01,5,false,1,`, [plan()], existing)
    expect(report.errors.map((e) => e.code)).toEqual(['DATE_OUTSIDE_CONTRACT', 'ALLOTMENT_BELOW_COMMITTED'])
  })

  it('carries the current cell version so apply can detect a changed cell', () => {
    const existing = new Map([['rp1|2099-03-01', { updatedAt: '2099-02-01T00:00:00.000Z', allotment: 10, sold: 0, held: 0, stopSell: false, minStay: 1, releaseDays: null }]])
    const report = validateSupplierCsv(`${header}\nRACK,2099-03-01,8,,,`, [plan()], existing)
    expect(report.ok).toBe(true)
    expect(report.cells[0]).toMatchObject({ allotment: 8, expectedUpdatedAt: '2099-02-01T00:00:00.000Z' })
  })

  it('rejects empty input and a file with nothing to change', () => {
    expect(validateSupplierCsv('', [plan()], none).fatal[0]!.code).toBe('FILE_EMPTY')
    expect(validateSupplierCsv(undefined, [plan()], none).ok).toBe(false)
    expect(validateSupplierCsv(`${header}\n`, [plan()], none).ok).toBe(false)
  })

  it('hashes the canonical cells independent of order', () => {
    const a = { ratePlanId: 'rp1', stayDate: '2099-03-01', allotment: 1, stopSell: false, minStay: 1, releaseDays: null }
    const b = { ratePlanId: 'rp1', stayDate: '2099-03-02', allotment: 2, stopSell: true, minStay: 1, releaseDays: 3 }
    expect(cellsSha256([a, b])).toBe(cellsSha256([b, a]))
    expect(cellsSha256([a, b])).not.toBe(cellsSha256([a, { ...b, allotment: 3 }]))
    expect(cellsSha256([a])).toMatch(/^[a-f0-9]{64}$/)
  })
})
