'use client'

import { useActionState } from 'react'
import type { ExtranetBookingStatus } from '@bedbanks/contracts'
import { answerBookingAction, type AnswerState } from '../../lib/actions'

/** `answers` is what the booking's current status allows; the server enforces it again. `idempotencyKey` is issued with the page, so resending this form cannot apply twice. */
export function BookingAnswerForm({ bookingId, expectedStatus, idempotencyKey, answers }: { bookingId: string; expectedStatus: ExtranetBookingStatus; idempotencyKey: string; answers: Array<'CONFIRMED' | 'ON_REQUEST' | 'REJECTED'> }) {
  const [state, dispatch, pending] = useActionState(answerBookingAction, { error: null } satisfies AnswerState)
  const label = { CONFIRMED: 'Confirm the booking', ON_REQUEST: 'Put on request', REJECTED: 'Reject the booking' } as const

  if (state.saved) {
    return <p className="inline-notice success" role="status">Answer recorded. The booking is now {state.answered?.replace(/_/g, ' ').toLowerCase()}.</p>
  }

  return (
    <form action={dispatch} className="form-section" aria-labelledby="answer-heading">
      <h2 id="answer-heading" className="form-title">Answer this booking</h2>
      <p className="form-lede">Your answer is recorded against this booking and cannot be undone from this page.</p>
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="expectedStatus" value={expectedStatus} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="form-grid">
        <label>Answer
          <select name="answer" required defaultValue="" disabled={pending}>
            <option value="" disabled>Choose an answer</option>
            {answers.map((answer) => <option key={answer} value={answer}>{label[answer]}</option>)}
          </select>
        </label>
        <label>Your booking reference (required to confirm)<input name="supplierRef" maxLength={120} disabled={pending} /></label>
        <label>Hotel confirmation number (optional)<input name="hotelConfirmationNo" maxLength={120} disabled={pending} /></label>
        <label>Reason (required to reject, at least 10 characters)<textarea name="reason" maxLength={500} disabled={pending} /></label>
      </div>
      <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={pending}>{pending ? 'Sending…' : 'Send answer'}</button></div>
      {state.error && <p className="inline-notice danger" role="alert">{state.error}</p>}
    </form>
  )
}
