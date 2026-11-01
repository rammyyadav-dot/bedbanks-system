import { missingAnswerFields, supplierAnswerAction } from './supplier-booking-answer'

describe('supplier booking answers (ADR 0061 Amendment 2)', () => {
  it('maps each allowed answer to the lifecycle action for the current status', () => {
    expect(supplierAnswerAction('CONFIRMED', 'PENDING_SUPPLIER')?.action).toBe('systemConfirm')
    expect(supplierAnswerAction('CONFIRMED', 'ON_REQUEST')?.action).toBe('systemConfirmOnRequest')
    expect(supplierAnswerAction('ON_REQUEST', 'PENDING_SUPPLIER')?.action).toBe('systemOnRequest')
    expect(supplierAnswerAction('REJECTED', 'PENDING_SUPPLIER')?.action).toBe('systemFail')
    expect(supplierAnswerAction('REJECTED', 'ON_REQUEST')?.action).toBe('systemRejectOnRequest')
  })

  it('refuses every other status, including closed and cancellation states', () => {
    for (const status of ['CONFIRMED', 'CANCEL_REQUESTED', 'CANCELLED', 'AMEND_REQUESTED', 'CHECKED_OUT', 'NO_SHOW', 'REJECTED', 'FAILED'] as const) {
      expect(supplierAnswerAction('CONFIRMED', status)).toBeNull()
      expect(supplierAnswerAction('REJECTED', status)).toBeNull()
      expect(supplierAnswerAction('ON_REQUEST', status)).toBeNull()
    }
    expect(supplierAnswerAction('ON_REQUEST', 'ON_REQUEST')).toBeNull()
  })

  it('requires a reference to confirm and a reason to reject', () => {
    expect(missingAnswerFields('CONFIRMED', {})).toEqual(['supplierRef'])
    expect(missingAnswerFields('CONFIRMED', { supplierRef: ' ' })).toEqual(['supplierRef'])
    expect(missingAnswerFields('CONFIRMED', { supplierRef: 'HX-1' })).toEqual([])
    expect(missingAnswerFields('REJECTED', { reason: 'too short' })).toEqual(['reason'])
    expect(missingAnswerFields('REJECTED', { reason: 'No rooms left for those dates' })).toEqual([])
    expect(missingAnswerFields('ON_REQUEST', {})).toEqual([])
  })
})
