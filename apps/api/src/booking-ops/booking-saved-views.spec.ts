import { SAVED_VIEW_NAME_MAX, normalizeSavedViewInput, normalizeViewColumns, normalizeViewName, resolveSavedView } from '@bedbanks/contracts'

const ok = (body: unknown) => { const r = normalizeSavedViewInput(body); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value }
const fields = (body: unknown) => { const r = normalizeSavedViewInput(body); return r.ok ? [] : r.issues.map((i) => i.field).sort() }

describe('saved views: validation and resolution (ADR 0039, Phase 6B)', () => {
  it('SV-01: a view stores a canonical query, a sort and a clean name, and nothing else', () => {
    const v = ok({ name: '  Overdue   Deadlines ', description: ' Next 48h ', filters: { status: 'FAILED,CONFIRMED', chip: 'deadline48h', agencyId: 'b,a' }, sort: { sort: 'amount', dir: 'asc' }, visibleColumns: ['status', 'reference'] })
    expect(v).toMatchObject({ name: 'Overdue Deadlines', nameKey: 'overdue deadlines', description: 'Next 48h', filterVersion: 1, sort: { sort: 'amount', dir: 'asc' } })
    expect(v.filters).toEqual({ chip: 'deadline48h', agencyId: 'a,b', status: 'CONFIRMED,FAILED' })
    expect(v.visibleColumns).toEqual(['reference', 'status', 'actions']) // Booking # first, Actions last
  })

  it('SV-02: names: trimmed, collapsed, bounded; names that differ only by case collide; control characters are refused', () => {
    expect(normalizeViewName('  A   b  ')).toBe('A b')
    expect(normalizeViewName('x'.repeat(SAVED_VIEW_NAME_MAX))).not.toBeNull(); expect(normalizeViewName('x'.repeat(SAVED_VIEW_NAME_MAX + 1))).toBeNull()
    for (const bad of ['', '   ', 'a\u0000b', 'a\tb\u0007', 5, null, undefined]) expect(normalizeViewName(bad)).toBeNull()
    expect(ok({ name: 'Failed', filters: {} }).nameKey).toBe(ok({ name: 'FAILED', filters: {} }).nameKey)
  })

  it('SV-03: unsafe content is rejected: tenant or actor fields, sort or paging inside filters, raw expressions, unknown fields', () => {
    expect(fields({ name: 'x', filters: { tenantId: 't' } })).toEqual(['tenantId'])
    expect(fields({ name: 'x', filters: { userId: 'u' } })).toEqual(['userId'])
    expect(fields({ name: 'x', filters: { where: '1=1' } })).toEqual(['where'])
    expect(fields({ name: 'x', filters: { page: '2' } })).toEqual(expect.arrayContaining(['filters']))
    expect(fields({ name: 'x', filters: { sort: 'amount' } })).toEqual(['filters'])
    expect(fields({ name: 'x', filters: {}, ownerUserId: 'someone', tenantId: 't' })).toEqual(['ownerUserId', 'tenantId'])
    expect(fields({ name: 'x', filters: [] })).toEqual(['filters'])
    expect(fields({ name: 'x', filters: {}, sort: { sort: 'name' } })).toEqual(['sort'])
    expect(fields({ name: 'x', filters: { status: 'NOPE' } })).toEqual(['status'])
    expect(fields(null)).toEqual(['*'])
  })

  it('SV-04: columns: known ids once each, or null; anything else is rejected', () => {
    expect(normalizeViewColumns(null)).toBeNull()
    expect(normalizeViewColumns(['hotel', 'status'])).toEqual(['reference', 'hotel', 'status', 'actions'])
    for (const bad of [['nope'], ['status', 'status'], 'status', [1], new Array(30).fill('status')]) expect(normalizeViewColumns(bad)).toBeUndefined()
    expect(fields({ name: 'x', filters: {}, visibleColumns: ['nope'] })).toEqual(['visibleColumns'])
  })

  it('SV-05: opening a stored view revalidates it under the CURRENT grammar', () => {
    const good = resolveSavedView({ filterVersion: 1, filters: { status: 'FAILED' }, sort: { sort: 'created', dir: 'desc' } })
    expect(good).toEqual({ status: 'ok', params: { status: 'FAILED' } })
    expect(resolveSavedView({ filterVersion: 1, filters: { status: 'NO_LONGER_A_STATUS' }, sort: { sort: 'created', dir: 'desc' } })).toMatchObject({ status: 'stale' })
    expect(resolveSavedView({ filterVersion: 1, filters: { tenantId: 'x' }, sort: {} })).toMatchObject({ status: 'stale' }) // a stored tenant id is never honoured
    expect(resolveSavedView({ filterVersion: 2, filters: {}, sort: {} })).toMatchObject({ status: 'stale' })
    expect(resolveSavedView({ filterVersion: 1, filters: 'x', sort: {} })).toMatchObject({ status: 'stale' })
  })

  it('SV-06: a view never carries more access than its caller has now: a newer restriction makes it restricted, not wider', () => {
    const stored = { filterVersion: 1, filters: { guest: 'Haddad' }, sort: { sort: 'created', dir: 'desc' } }
    expect(resolveSavedView(stored, () => [])).toMatchObject({ status: 'ok' })
    expect(resolveSavedView(stored, (q) => (q.guest ? [{ field: '*', code: 'INVALID_VALUE' as const, message: 'no longer allowed' }] : []))).toMatchObject({ status: 'restricted' })
  })

  it('SV-07: resolving is stable: params round-trip to the same view', () => {
    const v = ok({ name: 'x', filters: { hotel: 'atlantis', dateType: 'checkIn', from: '2030-01-01', to: '2030-01-31' }, sort: { sort: 'checkIn', dir: 'asc' } })
    const r1 = resolveSavedView({ filterVersion: v.filterVersion, filters: v.filters, sort: v.sort })
    expect(r1.status).toBe('ok')
    if (r1.status === 'ok') {
      const v2 = ok({ name: 'x', filters: Object.fromEntries(Object.entries(r1.params).filter(([k]) => k !== 'sort' && k !== 'dir')), sort: { sort: r1.params.sort ?? 'created', dir: r1.params.dir ?? 'desc' } })
      expect(v2.filters).toEqual(v.filters); expect(v2.sort).toEqual(v.sort)
    }
  })
})
