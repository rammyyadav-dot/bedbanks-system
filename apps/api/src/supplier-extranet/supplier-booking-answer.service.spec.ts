import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { transitionBooking } from '../booking-ops/booking-transition'
import { SupplierBookingAnswerService } from './supplier-booking-answer.service'
import { ANSWER_REQUIRES_SETTLEMENT } from './supplier-booking-answer'
import type { AnswerBookingDto } from './answer-booking.dto'

jest.mock('../booking-ops/booking-transition', () => ({ transitionBooking: jest.fn() }))

const KEY = 'answer-key-0001'

function harness(opts: { locked?: boolean; status?: string; earlier?: boolean } = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(opts.locked === false ? [] : [{ id: 'b1' }]),
    booking: { findFirstOrThrow: jest.fn().mockResolvedValue({ status: opts.status ?? 'PENDING_SUPPLIER' }), updateMany: jest.fn() },
    bookingEvent: { findUnique: jest.fn().mockResolvedValue(opts.earlier ? { id: 'e1' } : null), create: jest.fn() },
    bookingFinanceEvent: { create: jest.fn() },
    auditEvent: { createMany: jest.fn() },
  }
  const db = { withTenantWrite: jest.fn((_tenant: string, work: (t: typeof tx) => Promise<unknown>) => work(tx)) }
  const extranet = { requirePermission: jest.fn().mockResolvedValue(undefined) }
  const service = new SupplierBookingAnswerService(db as never, extranet as never)
  const answer = (body: Partial<AnswerBookingDto>) => service.answer('t1', 'u1', 's1', 'b1', { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'HX-1', ...body } as AnswerBookingDto, KEY, 'req-1')
  return { tx, answer }
}

const noWrites = (tx: ReturnType<typeof harness>['tx']) => {
  expect(transitionBooking).not.toHaveBeenCalled()
  expect(tx.booking.updateMany).not.toHaveBeenCalled()
  expect(tx.bookingEvent.create).not.toHaveBeenCalled()
  expect(tx.bookingFinanceEvent.create).not.toHaveBeenCalled()
  expect(tx.auditEvent.createMany).not.toHaveBeenCalled()
}

describe('SupplierBookingAnswerService: answers wait for settlement (ADR 0061 Amendment 4)', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['confirm a pending booking', { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'HX-1' }, 'PENDING_SUPPLIER'],
    ['put a pending booking on request', { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER' }, 'PENDING_SUPPLIER'],
    ['reject a pending booking', { answer: 'REJECTED', expectedStatus: 'PENDING_SUPPLIER', reason: 'No rooms left for those dates' }, 'PENDING_SUPPLIER'],
    ['confirm an on-request booking', { answer: 'CONFIRMED', expectedStatus: 'ON_REQUEST', supplierRef: 'HX-2' }, 'ON_REQUEST'],
    ['reject an on-request booking', { answer: 'REJECTED', expectedStatus: 'ON_REQUEST', reason: 'Hotel closed for renovation' }, 'ON_REQUEST'],
  ] as const)('refuses to %s and writes nothing', async (_label, body, status) => {
    const { tx, answer } = harness({ status })
    const error = await answer(body as Partial<AnswerBookingDto>).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictException)
    expect((error as ConflictException).getResponse()).toMatchObject({ code: ANSWER_REQUIRES_SETTLEMENT, currentStatus: status })
    noWrites(tx)
  })

  it('still reports an answer that does not fit the status as not available', async () => {
    const { tx, answer } = harness({ status: 'CONFIRMED' })
    const error = await answer({ answer: 'REJECTED', expectedStatus: 'CONFIRMED', reason: 'Changed our mind later' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'ANSWER_NOT_AVAILABLE' })
    noWrites(tx)
  })

  it('still hides a booking outside the organization as not found', async () => {
    const { tx, answer } = harness({ locked: false })
    await expect(answer({})).rejects.toBeInstanceOf(NotFoundException)
    noWrites(tx)
  })

  it('replays an answer that was already recorded, whatever the booking has become since', async () => {
    ;(transitionBooking as jest.Mock).mockResolvedValue({ bookingId: 'b1', reference: 'FB-1', status: 'CONFIRMED', replayed: true })
    const { tx, answer } = harness({ status: 'CONFIRMED', earlier: true })
    await expect(answer({})).resolves.toEqual({ bookingId: 'b1', reference: 'FB-1', status: 'CONFIRMED', replayed: true })
    expect(transitionBooking).toHaveBeenCalledTimes(1)
    expect(tx.auditEvent.createMany).not.toHaveBeenCalled()
  })
})
