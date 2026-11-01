import { BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common'
import { BOOKING_BULK_ACTIONS, BOOKING_BULK_ITEM_ERRORS, BOOKING_BULK_MAX_IDS, BOOKING_BULK_PERMISSION, finalBulkStatus, validateBulkRequest, type BookingBulkRequest } from '@bedbanks/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bulkFingerprint, innerKey, mapBulkItemError } from './booking-bulk.service'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `bk${String(i).padStart(4, '0')}`)
const assign = (over: Record<string, unknown> = {}) => ({ bookingIds: ids(3), action: 'ASSIGN_OWNER', payload: { assigneeUserId: 'user-1' }, idempotencyKey: 'key-0123456789', ...over })
const issues = (body: unknown) => { const r = validateBulkRequest(body); return r.ok ? [] : r.issues.map((i) => `${i.field}:${i.code}`) }

describe('bulk actions: contract, mapping and aggregation (ADR 0039, Phase 6C)', () => {
  it('BU-01: a valid request normalizes; the action list contains only non-financial operations', () => {
    expect(validateBulkRequest(assign())).toMatchObject({ ok: true, value: { action: 'ASSIGN_OWNER', payload: { assigneeUserId: 'user-1' } } })
    expect(validateBulkRequest(assign({ payload: { assigneeUserId: null } }))).toMatchObject({ ok: true })
    expect(validateBulkRequest(assign({ action: 'ACKNOWLEDGE', payload: {} }))).toMatchObject({ ok: true })
    expect(validateBulkRequest(assign({ action: 'ACKNOWLEDGE', payload: undefined }))).toMatchObject({ ok: true })
    expect([...BOOKING_BULK_ACTIONS]).toEqual(['ASSIGN_OWNER', 'ACKNOWLEDGE'])
    for (const forbidden of ['CANCEL', 'REQUEST_CANCELLATION', 'DECIDE_PENALTY', 'WAIVE_PENALTY', 'ISSUE_INVOICE', 'ISSUE_CREDIT_NOTE', 'ISSUE_VOUCHER', 'MONEY_EVENT', 'REFUND', 'PAYMENT', 'CONFIRM', 'CLOSE']) {
      expect(issues(assign({ action: forbidden }))).toContain('action:BOOKING_BULK_UNSUPPORTED_ACTION')
      expect((BOOKING_BULK_ACTIONS as readonly string[]).includes(forbidden)).toBe(false)
    }
  })

  it('BU-02: ids: empty, duplicate, malformed and over the limit are refused, never truncated or silently de-duplicated', () => {
    expect(issues(assign({ bookingIds: [] }))).toEqual(['bookingIds:BOOKING_BULK_EMPTY'])
    expect(issues(assign({ bookingIds: ['a1', 'a2', 'a1'] }))).toEqual(['bookingIds:BOOKING_BULK_DUPLICATE_IDS'])
    expect(issues(assign({ bookingIds: ids(BOOKING_BULK_MAX_IDS + 1) }))).toEqual(['bookingIds:BOOKING_BULK_TOO_MANY'])
    expect(validateBulkRequest(assign({ bookingIds: ids(BOOKING_BULK_MAX_IDS) }))).toMatchObject({ ok: true })
    for (const bad of [['has space'], ['a/b'], [''], [1], [null], 'abc', { 0: 'a' }, undefined]) expect(issues(assign({ bookingIds: bad }))).toContain('bookingIds:BOOKING_BULK_INVALID')
    const r = validateBulkRequest(assign({ bookingIds: ids(101) })); expect(r.ok === false && r.issues[0].message).toMatch(/At most 100.*101.*Nothing was processed/)
  })

  it('BU-03: payloads are action-specific and strict; unknown fields are refused', () => {
    expect(issues(assign({ payload: { assigneeUserId: 5 } }))).toEqual(['payload.assigneeUserId:BOOKING_BULK_INVALID'])
    expect(issues(assign({ payload: { assigneeUserId: 'a b' } }))).toEqual(['payload.assigneeUserId:BOOKING_BULK_INVALID'])
    expect(issues(assign({ payload: {} }))).toEqual(['payload.assigneeUserId:BOOKING_BULK_INVALID']) // omitting the assignee is not "unassign": say null
    expect(issues(assign({ payload: { assigneeUserId: 'u1', tenantId: 't' } }))).toEqual(['payload:BOOKING_BULK_UNKNOWN_FIELD'])
    expect(issues(assign({ action: 'ACKNOWLEDGE', payload: { assigneeUserId: 'u1' } }))).toEqual(['payload:BOOKING_BULK_UNKNOWN_FIELD'])
    expect(issues(assign({ payload: [] }))).toEqual(['payload:BOOKING_BULK_INVALID'])
    expect(issues(assign({ tenantId: 'x', requestedBy: 'y' }))).toEqual(['tenantId:BOOKING_BULK_UNKNOWN_FIELD', 'requestedBy:BOOKING_BULK_UNKNOWN_FIELD'])
    for (const bad of [null, [], 'x', 5]) expect(validateBulkRequest(bad).ok).toBe(false)
  })

  it('BU-04: the idempotency key is required and bounded', () => {
    for (const k of [undefined, '', 'short', 'has space in it', 'x'.repeat(129), 123]) expect(issues(assign({ idempotencyKey: k }))).toEqual(['idempotencyKey:BOOKING_BULK_INVALID'])
    expect(validateBulkRequest(assign({ idempotencyKey: 'x'.repeat(128) })).ok).toBe(true)
  })

  it('BU-05: every problem is reported at once', () => {
    expect(issues({ bookingIds: [], action: 'NOPE', payload: 5, idempotencyKey: 'x', extra: 1 }).sort()).toEqual(['action:BOOKING_BULK_UNSUPPORTED_ACTION', 'bookingIds:BOOKING_BULK_EMPTY', 'extra:BOOKING_BULK_UNKNOWN_FIELD', 'idempotencyKey:BOOKING_BULK_INVALID'])
  })

  it('BU-06: capability names: one bulk permission per action, distinct from the underlying single-booking permission', () => {
    expect(BOOKING_BULK_PERMISSION).toEqual({ ASSIGN_OWNER: 'booking.bulk.assign', ACKNOWLEDGE: 'booking.bulk.acknowledge' })
  })

  it('BU-07: the operation status is never "success" while anything failed', () => {
    expect(finalBulkStatus(5, 0)).toBe('SUCCEEDED')
    expect(finalBulkStatus(0, 5)).toBe('FAILED')
    expect(finalBulkStatus(91, 9)).toBe('PARTIAL')
    expect(finalBulkStatus(1, 99)).toBe('PARTIAL')
    expect(finalBulkStatus(99, 1)).toBe('PARTIAL')
  })

  it('BU-08: errors from the single-booking service map to stable codes, never to a message', () => {
    const code = (c: string) => ({ message: 'secret text', code: c })
    expect(mapBulkItemError(new NotFoundException(code('BOOKING_NOT_FOUND')))).toBe('NOT_FOUND')
    expect(mapBulkItemError(new ForbiddenException(code('BOOKING_OPS_FORBIDDEN')))).toBe('FORBIDDEN')
    expect(mapBulkItemError(new ForbiddenException(code('BOOKING_OPS_CROSS_TENANT_DENIED')))).toBe('ASSIGNEE_NOT_ALLOWED')
    expect(mapBulkItemError(new ForbiddenException(code('BOOKING_OPS_INELIGIBLE_ASSIGNEE')))).toBe('ASSIGNEE_NOT_ALLOWED')
    expect(mapBulkItemError(new ConflictException(code('BOOKING_OPS_INVALID_TRANSITION')))).toBe('INVALID_STATE')
    expect(mapBulkItemError(new ConflictException(code('BOOKING_OPS_CONFLICT')))).toBe('STALE_STATE')
    expect(mapBulkItemError(new ConflictException(code('IDEMPOTENCY_CONFLICT')))).toBe('IDEMPOTENCY_CONFLICT')
    expect(mapBulkItemError(new ConflictException(code('SOMETHING_ELSE')))).toBe('INVALID_STATE')
    for (const e of [new BadRequestException('x'), new UnprocessableEntityException('x'), new ServiceUnavailableException('db down'), new InternalServerErrorException('x'), new Error('connection string postgresql://u:p@h'), 'boom', null, undefined]) expect(mapBulkItemError(e)).toBe('INTERNAL_ERROR')
    for (const c of ['NOT_FOUND', 'FORBIDDEN', 'ASSIGNEE_NOT_ALLOWED', 'INVALID_STATE', 'STALE_STATE', 'IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR']) expect((BOOKING_BULK_ITEM_ERRORS as readonly string[]).includes(c)).toBe(true)
  })

  it('BU-09: idempotency identity: the fingerprint ignores id order; the inner key comes from the persisted operation and the booking only', () => {
    const a = validateBulkRequest(assign({ bookingIds: ['b1', 'b2', 'b3'] })); const b = validateBulkRequest(assign({ bookingIds: ['b3', 'b1', 'b2'] })); const c = validateBulkRequest(assign({ bookingIds: ['b1', 'b2'] }))
    const d = validateBulkRequest(assign({ bookingIds: ['b1', 'b2', 'b3'], payload: { assigneeUserId: 'user-2' } }))
    const fp = (r: ReturnType<typeof validateBulkRequest>) => bulkFingerprint((r as { value: BookingBulkRequest }).value)
    expect(fp(a)).toBe(fp(b)); expect(fp(a)).not.toBe(fp(c)); expect(fp(a)).not.toBe(fp(d))
    expect(innerKey('op1', 'b1')).toBe('bulk:op1:b1')
    expect(innerKey('op1', 'b1')).toBe(innerKey('op1', 'b1')); expect(innerKey('op1', 'b1')).not.toBe(innerKey('op2', 'b1')); expect(innerKey('op1', 'b1')).not.toBe(innerKey('op1', 'b2'))
    expect(innerKey('c'.repeat(25), 'b'.repeat(80)).length).toBeLessThanOrEqual(128) // fits the single-booking key limit
    expect(innerKey('c'.repeat(25), 'b'.repeat(80))).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
  })

  it('BU-10: the bulk service has no mutation path of its own: it writes only its own two tables and calls the single-booking service for every business effect', () => {
    const source = readFileSync(join(__dirname, 'booking-bulk.service.ts'), 'utf8')
    for (const forbidden of [/\.booking\.(update|updateMany|upsert|create|delete|deleteMany)\b/, /\bbookingOpsState\.(update|updateMany|create|upsert|delete)/, /\bbookingEvent\.(create|createMany|update|delete)/, /\$executeRaw/, /\$queryRaw/, /\bledger/i, /\bwallet/i, /bookingFinanceEvent/, /bookingDocument/]) expect(source).not.toMatch(forbidden)
    expect(source).toMatch(/this\.ops\.assign\(/); expect(source).toMatch(/this\.ops\.acknowledge\(/)
  })
})
