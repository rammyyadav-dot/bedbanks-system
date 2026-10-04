import { BadRequestException, ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { HttpExceptionFilter } from './http-exception.filter'
import { CommercialControlUnavailableError } from '../../supply/commercial-controls'

function run(exception: unknown) {
  let status = 0
  let body: { error: { code: string; message: string; details: unknown[] } } | undefined
  const response = { status(code: number) { status = code; return this }, json(payload: typeof body) { body = payload } }
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ method: 'GET', url: '/x', requestId: 'req-1' }) }) } as unknown as ArgumentsHost
  new HttpExceptionFilter().catch(exception, host)
  return { status, error: body!.error }
}

describe('HttpExceptionFilter codes', () => {
  it('keeps status-derived codes for ordinary exceptions', () => {
    expect(run(new ForbiddenException('nope')).error.code).toBe('FORBIDDEN')
    expect(run(new ServiceUnavailableException('down')).error.code).toBe('SERVICE_UNAVAILABLE')
    expect(run(new BadRequestException(['a', 'b'])).error).toMatchObject({ code: 'VALIDATION_ERROR', details: ['a', 'b'] })
  })

  it('uses an explicit domain code when the exception body carries a valid one', () => {
    const result = run(new ServiceUnavailableException({ message: 'Runtime role cannot read this', code: 'OPERATIONS_READ_DENIED' }))
    expect(result.status).toBe(503)
    expect(result.error).toMatchObject({ code: 'OPERATIONS_READ_DENIED', message: 'Runtime role cannot read this' })
  })

  it('ignores malformed explicit codes instead of echoing arbitrary text', () => {
    for (const code of ['lowercase', 'HAS SPACE', '<script>', 'A', 'X'.repeat(60), 42, null]) {
      expect(run(new ServiceUnavailableException({ message: 'm', code })).error.code).toBe('SERVICE_UNAVAILABLE')
    }
  })

  it('never leaks internals for unexpected errors', () => {
    const result = run(new Error('db password is hunter2'))
    expect(result.status).toBe(500)
    expect(result.error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' })
    expect(new HttpException('x', 418)).toBeDefined()
  })

  it('maps a database privilege failure to a sanitized 503, never a 403 or a 500 (ADR 0031)', () => {
    const denied = Object.assign(new Error('permission denied for table "HotelProfile"'), { meta: { code: '42501' } })
    const result = run(denied)
    expect(result.status).toBe(503)
    expect(result.error.code).toBe('DATABASE_ROLE_NOT_PERMITTED')
    expect(JSON.stringify(result.error)).not.toMatch(/HotelProfile|42501|permission denied/)
  })

  it('does not treat an intentional 403 or a row-level-security violation as a grant failure', () => {
    expect(run(new ForbiddenException('Insufficient permission')).status).toBe(403)
    expect(run(new Error('new row violates row-level security policy for table "Agency"')).status).toBe(500)
  })

  it('maps an unreadable mandatory commercial control to 503 COMMERCIAL_CONTROL_UNAVAILABLE', () => {
    const result = run(new CommercialControlUnavailableError('markup_rules', 'denied', '42501'))
    expect(result.status).toBe(503)
    expect(result.error.code).toBe('COMMERCIAL_CONTROL_UNAVAILABLE')
  })
})
