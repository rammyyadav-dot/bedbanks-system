import { BadRequestException } from '@nestjs/common'
import { CREDIT_NOTE_FAILURE, CREDIT_NOTE_REASONS, type CreditNoteReasonName } from '@bedbanks/contracts'

const bad = (message: string) => new BadRequestException({ message, code: CREDIT_NOTE_FAILURE.invalid })
const CONTROL = /[\u0000-\u001f\u007f]/
const ID = /^[A-Za-z0-9_.:-]{1,80}$/

export interface CreditNoteProposal { requestId: string; bookingId: string; amountMinor: bigint; reason: CreditNoteReasonName; note: string }

/** Validates and normalises a proposal. Pure, so every refusal is unit-tested without a database. */
export function parseCreditNoteProposal(body: unknown): CreditNoteProposal {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A request body is required')
  const b = body as Record<string, unknown>
  const requestId = typeof b.requestId === 'string' ? b.requestId.trim() : ''
  if (requestId.length < 8 || requestId.length > 80 || !ID.test(requestId)) throw bad('requestId must be 8 to 80 characters (letters, digits, . _ : -)')
  const bookingId = typeof b.bookingId === 'string' ? b.bookingId.trim() : ''
  if (!ID.test(bookingId)) throw bad('bookingId is required')
  const amount = typeof b.amountMinor === 'string' ? b.amountMinor.trim() : ''
  if (!/^[1-9]\d{0,17}$/.test(amount)) throw bad('amountMinor must be a positive whole number of minor units (digits only)')
  if (typeof b.reason !== 'string' || !(CREDIT_NOTE_REASONS as readonly string[]).includes(b.reason)) throw bad(`reason must be one of ${CREDIT_NOTE_REASONS.join(', ')}`)
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if (note.length < 3 || note.length > 500 || CONTROL.test(note)) throw bad('note must be 3 to 500 printable characters')
  return { requestId, bookingId, amountMinor: BigInt(amount), reason: b.reason as CreditNoteReasonName, note }
}

/** A rejection reason (3 to 500 printable characters). */
export function parseDecisionReason(body: unknown): string {
  const reason = body && typeof body === 'object' && typeof (body as Record<string, unknown>).reason === 'string' ? ((body as Record<string, unknown>).reason as string).trim() : ''
  if (reason.length < 3 || reason.length > 500 || CONTROL.test(reason)) throw bad('reason must be 3 to 500 printable characters')
  return reason
}
