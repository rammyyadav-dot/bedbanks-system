import { databaseErrorCode, isDatabasePermissionDenied } from './db-errors'

describe('database permission errors', () => {
  it('recognises 42501 by driver code and by message, and nothing else', () => {
    expect(isDatabasePermissionDenied(Object.assign(new Error('x'), { meta: { code: '42501' } }))).toBe(true)
    expect(isDatabasePermissionDenied(new Error('permission denied for table "Agency"'))).toBe(true)
    expect(isDatabasePermissionDenied(new Error('permission denied for sequence foo'))).toBe(true)
    expect(isDatabasePermissionDenied(new Error('new row violates row-level security policy for table "Agency"'))).toBe(false)
    expect(isDatabasePermissionDenied(new Error('connection lost'))).toBe(false)
    expect(isDatabasePermissionDenied(null)).toBe(false)
    expect(isDatabasePermissionDenied('permission denied for table x')).toBe(false)
  })
  it('exposes only a code, never the message', () => {
    expect(databaseErrorCode(Object.assign(new Error('permission denied for table "Agency" host=h'), { meta: { code: '42501' } }))).toBe('42501')
    expect(databaseErrorCode(new Error('permission denied for table "Agency"'))).toBe('42501')
    expect(databaseErrorCode(Object.assign(new Error('x'), { code: 'P2002' }))).toBe('P2002')
    expect(databaseErrorCode(new Error('weird'))).toBe('unknown')
  })
})
