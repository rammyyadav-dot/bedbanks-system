import {
  actionBlock, availableActions, BOOKING_ACTION_RULES, BOOKING_ACTIONS, BOOKING_STATUSES, BOOKING_TRANSITIONS, isLegalMove, permissionFor, NO_SHOW_WINDOW_DAYS,
  type BookingActionFacts, type BookingStatus,
} from '@bedbanks/contracts'

const NOW = new Date('2030-06-10T10:00:00.000Z')
const facts = (over: Partial<BookingActionFacts> = {}): BookingActionFacts => ({ status: 'CONFIRMED', closedAt: null, isRefundable: true, checkIn: '2030-06-20', ...over })
const held = (...keys: string[]) => new Set(keys)

describe('booking lifecycle table (spec "Booking lifecycle")', () => {
  it('LC-01: exactly the spec table of legal moves, for every ordered pair of the ten statuses', () => {
    const legal: Array<[BookingStatus, BookingStatus]> = [
      ['PENDING_SUPPLIER', 'CONFIRMED'], ['PENDING_SUPPLIER', 'ON_REQUEST'], ['PENDING_SUPPLIER', 'FAILED'], ['ON_REQUEST', 'CONFIRMED'], ['ON_REQUEST', 'REJECTED'],
      ['CONFIRMED', 'AMEND_REQUESTED'], ['CONFIRMED', 'CANCEL_REQUESTED'], ['CONFIRMED', 'CHECKED_OUT'], ['AMEND_REQUESTED', 'CONFIRMED'], ['CANCEL_REQUESTED', 'CANCELLED'], ['CHECKED_OUT', 'NO_SHOW'],
    ]
    for (const from of BOOKING_STATUSES) for (const to of BOOKING_STATUSES) expect({ from, to, ok: isLegalMove(from, to) }).toEqual({ from, to, ok: legal.some(([a, b]) => a === from && b === to) })
    expect(BOOKING_STATUSES).toHaveLength(10)
  })

  it('LC-02: terminal statuses have no outgoing move; Failed is never revived', () => {
    for (const s of ['NO_SHOW', 'CANCELLED', 'REJECTED', 'FAILED'] as const) expect(BOOKING_TRANSITIONS[s]).toEqual([])
    expect(isLegalMove('FAILED', 'PENDING_SUPPLIER')).toBe(false); expect(isLegalMove('FAILED', 'CONFIRMED')).toBe(false)
  })

  it('LC-03: every named action is a legal move (or the close lock), and every legal move is reachable by some action', () => {
    for (const a of BOOKING_ACTIONS) { const r = BOOKING_ACTION_RULES[a]; expect(a === 'close' ? r.from === r.to : isLegalMove(r.from, r.to)).toBe(true) }
    for (const from of BOOKING_STATUSES) for (const to of BOOKING_TRANSITIONS[from]) expect(BOOKING_ACTIONS.some((a) => BOOKING_ACTION_RULES[a].from === from && BOOKING_ACTION_RULES[a].to === to)).toBe(true)
  })

  it('LC-04: a closed booking offers nothing, and an action is offered only from its own status', () => {
    expect(availableActions(facts({ status: 'FAILED', closedAt: '2030-06-01T00:00:00.000Z' }), 'OPERATOR', held('booking.rebook'), NOW)).toEqual([])
    expect(actionBlock(BOOKING_ACTION_RULES.confirmOnRequest, facts({ status: 'CONFIRMED' }), NOW)).toBe('WRONG_STATUS')
    expect(actionBlock(BOOKING_ACTION_RULES.confirmOnRequest, facts({ status: 'ON_REQUEST' }), NOW)).toBeNull()
  })

  it('LC-05: no-show only within 7 days of check-in (inclusive), never without stay dates', () => {
    const rule = BOOKING_ACTION_RULES.markNoShow
    expect(NO_SHOW_WINDOW_DAYS).toBe(7)
    expect(actionBlock(rule, facts({ status: 'CHECKED_OUT', checkIn: '2030-06-03' }), NOW)).toBeNull() // 7 days ago
    expect(actionBlock(rule, facts({ status: 'CHECKED_OUT', checkIn: '2030-06-02' }), NOW)).toBe('NO_SHOW_WINDOW')
    expect(actionBlock(rule, facts({ status: 'CHECKED_OUT', checkIn: null }), NOW)).toBe('NO_STAY_DATES')
  })
})

describe('who may do what (spec roles matrix)', () => {
  it('LC-06: confirm / reject on request, manual confirm, edit refs, amend, no-show, close need their own key; one key does not grant another', () => {
    const op = (a: keyof typeof BOOKING_ACTION_RULES, ...keys: string[]) => permissionFor(BOOKING_ACTION_RULES[a], 'OPERATOR', held(...keys), true)
    expect(op('confirmOnRequest', 'booking.on-request.resolve')).toBe('booking.on-request.resolve'); expect(op('confirmOnRequest', 'booking.confirm.manual')).toBeNull()
    expect(op('rejectOnRequest', 'booking.on-request.resolve')).toBe('booking.on-request.resolve')
    expect(op('recordConfirmed', 'booking.confirm.manual')).toBe('booking.confirm.manual'); expect(op('recordConfirmed', 'booking.on-request.resolve')).toBeNull()
    expect(op('approveAmendment', 'booking.amend')).toBe('booking.amend'); expect(op('approveAmendment', 'booking.amend.request')).toBeNull()
    expect(op('markNoShow', 'booking.no-show.mark')).toBe('booking.no-show.mark'); expect(op('markNoShow', 'booking.read')).toBeNull()
    expect(op('close', 'booking.rebook')).toBe('booking.rebook'); expect(op('close', 'booking.cancel')).toBeNull()
    expect(op('confirmOnRequest', 'booking.read', 'booking.view.net')).toBeNull()
  })

  it('LC-07: cancelling a refundable booking needs booking.cancel; a non-refundable or unknown one needs booking.cancel.nonrefundable', () => {
    const cancel = (refundable: boolean | null, ...keys: string[]) => permissionFor(BOOKING_ACTION_RULES.requestCancellation, 'OPERATOR', held(...keys), refundable)
    expect(cancel(true, 'booking.cancel')).toBe('booking.cancel')
    expect(cancel(false, 'booking.cancel')).toBeNull(); expect(cancel(null, 'booking.cancel')).toBeNull() // unknown is treated as non-refundable
    expect(cancel(false, 'booking.cancel.nonrefundable')).toBe('booking.cancel.nonrefundable'); expect(cancel(null, 'booking.cancel.nonrefundable')).toBe('booking.cancel.nonrefundable')
    const record = (refundable: boolean | null, ...keys: string[]) => permissionFor(BOOKING_ACTION_RULES.confirmCancellation, 'OPERATOR', held(...keys), refundable)
    expect(record(false, 'booking.cancel')).toBeNull(); expect(record(false, 'booking.cancel.nonrefundable')).toBe('booking.cancel.nonrefundable')
  })

  it('LC-08: an agency user can only request: amendment and cancellation, with their own request keys, never approve, confirm or record', () => {
    const ag = (a: keyof typeof BOOKING_ACTION_RULES, ...keys: string[]) => permissionFor(BOOKING_ACTION_RULES[a], 'AGENCY', held(...keys), false)
    expect(ag('requestAmendment', 'booking.amend.request')).toBe('booking.amend.request'); expect(ag('requestAmendment', 'booking.amend')).toBeNull()
    expect(ag('requestCancellation', 'booking.cancel.request')).toBe('booking.cancel.request'); expect(ag('requestCancellation', 'booking.cancel', 'booking.cancel.nonrefundable')).toBeNull()
    for (const a of ['confirmOnRequest', 'rejectOnRequest', 'approveAmendment', 'rejectAmendment', 'confirmCancellation', 'markNoShow', 'recordConfirmed', 'close'] as const) expect(ag(a, 'booking.cancel.request', 'booking.amend.request', 'booking.on-request.resolve', 'booking.amend')).toBeNull()
  })

  it('LC-09: the system-only check-out is never offered to a person', () => {
    expect(availableActions(facts(), 'OPERATOR', held('booking.cancel', 'booking.amend', 'booking.no-show.mark', 'booking.rebook', 'booking.confirm.manual', 'booking.on-request.resolve'), NOW).map((a) => a.action)).toEqual(['requestAmendment', 'requestCancellation'])
    expect(availableActions(facts(), 'OPERATOR', held(), NOW)).toEqual([])
  })

  it('LC-10: the second confirmation is demanded for non-refundable, unknown and every agency cancellation request', () => {
    const need = (isRefundable: boolean | null, level: 'OPERATOR' | 'AGENCY', ...keys: string[]) => availableActions(facts({ isRefundable }), level, held(...keys), NOW).find((a) => a.action === 'requestCancellation')?.needsSecondConfirmation
    expect(need(true, 'OPERATOR', 'booking.cancel')).toBe(false); expect(need(false, 'OPERATOR', 'booking.cancel.nonrefundable')).toBe(true)
    expect(need(null, 'OPERATOR', 'booking.cancel.nonrefundable')).toBe(true); expect(need(true, 'AGENCY', 'booking.cancel.request')).toBe(true)
  })
})
