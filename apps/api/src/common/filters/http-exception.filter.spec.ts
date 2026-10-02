import { BadRequestException, ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { HttpExceptionFilter } from './http-exception.filter'

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
})
