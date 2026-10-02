import { BadRequestException } from '@nestjs/common'
import { boolParam, dayParam, enumParam, idParam, intParam, pageParams, textParam } from './query-params'

describe('operations query parameters', () => {
  it('defaults and bounds pagination, and rejects instead of widening', () => {
    expect(pageParams({})).toEqual({ page: 1, pageSize: 25, skip: 0, take: 25 })
    expect(pageParams({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10, skip: 20, take: 10 })
    for (const bad of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'x' }, { pageSize: '0' }, { pageSize: '101' }, { pageSize: 'all' }, { page: '100001' }]) {
      expect(() => pageParams(bad)).toThrow(BadRequestException)
    }
  })

  it('accepts identifiers but rejects wildcard, path and SQL-looking input', () => {
    expect(idParam('id', 'cmup4jbfb01sa2ghbfw0dznnt')).toBe('cmup4jbfb01sa2ghbfw0dznnt')
    expect(idParam('requestId', 'a1b2c3d4-0000-4000-8000-000000000001')).toBeDefined()
    expect(idParam('id', undefined)).toBeUndefined()
    for (const bad of ['%', 'a b', "x'; DROP TABLE", '../x', '*', 'a'.repeat(81), 5, {}]) expect(() => idParam('id', bad)).toThrow(BadRequestException)
  })

  it('validates enums against an allow-list', () => {
    expect(enumParam('status', 'HELD', ['HELD', 'RELEASED'] as const)).toBe('HELD')
    expect(enumParam('status', '', ['HELD'] as const)).toBeUndefined()
    expect(() => enumParam('status', 'held', ['HELD'] as const)).toThrow(BadRequestException)
    expect(() => enumParam('status', 'DROP', ['HELD'] as const)).toThrow(BadRequestException)
  })

  it('parses real calendar days only', () => {
    expect(dayParam('from', '2026-10-02')?.toISOString()).toBe('2026-10-02T00:00:00.000Z')
    for (const bad of ['2026-02-31', '2026-13-01', '20261002', '2026-10-2', 'today', '2026-10-02T00:00:00Z']) expect(() => dayParam('from', bad)).toThrow(BadRequestException)
  })

  it('limits free text and booleans and integers', () => {
    expect(textParam('search', '  Burj  ')).toBe('Burj')
    expect(textParam('search', '   ')).toBeUndefined()
    expect(() => textParam('search', 'x'.repeat(65))).toThrow(BadRequestException)
    expect(() => textParam('search', 'a\u0000b')).toThrow(BadRequestException)
    expect(boolParam('attention', 'true')).toBe(true)
    expect(() => boolParam('attention', 'yes')).toThrow(BadRequestException)
    expect(intParam('days', '7', 1, 31)).toBe(7)
    expect(() => intParam('days', '32', 1, 31)).toThrow(BadRequestException)
  })
})
