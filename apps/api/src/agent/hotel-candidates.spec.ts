import { completeHotelsInCity } from './hotel-candidates'

describe('completeHotelsInCity (ADR 0074)', () => {
  it('is an indexed, tenant-scoped equality on the generated city key, never ILIKE or lower() on the column', () => {
    const q = completeHotelsInCity({ tenantId: 't1', city: 'Dubai' })
    expect(q.sql).toContain('"tenant_id" = ?')
    expect(q.sql).toContain('"city_key" = lower(?)')
    expect(q.sql).toContain(`"content_status" = 'COMPLETE'`)
    expect(q.sql).not.toMatch(/ILIKE|lower\("city"\)/)
    expect(q.values).toEqual(['t1', 'Dubai'])
  })

  it('binds optional hotel and property-type filters as parameters', () => {
    const q = completeHotelsInCity({ tenantId: 't1', city: "O'Hare; DROP TABLE", canonicalHotelIds: ['h1', 'h2'], propertyTypes: ['Resort'] })
    expect(q.sql).toContain('"id" = ANY(?::text[])')
    expect(q.sql).toContain('"property_type" = ANY(?::text[])')
    expect(q.sql).not.toContain('DROP')
    expect(q.values).toEqual(['t1', "O'Hare; DROP TABLE", ['h1', 'h2'], ['Resort']])
  })
})
