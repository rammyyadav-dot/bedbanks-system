import { BadRequestException } from '@nestjs/common'
import {
  LEDGER_ADJUSTMENT_DIRECTIONS, LEDGER_ADJUSTMENT_FAILURE, LEDGER_ADJUSTMENT_KINDS, LEDGER_ADJUSTMENT_REASONS, LEDGER_REVERSAL_REASONS,
  type LedgerAdjustmentDirectionName, type LedgerAdjustmentKindName, type LedgerAdjustmentReasonName,
} from '@bedbanks/contracts'

const bad = (message: string) => new BadRequestException({ message, code: LEDGER_ADJUSTMENT_FAILURE.invalid })
const CONTROL = /[\u0000-\u001f\u007f]/
const ID = /^[A-Za-z0-9_.:-]{1,80}$/

export interface LedgerAdjustmentProposal {
  requestId: string; kind: LedgerAdjustmentKindName; agencyId: string; currency: string
  /** The stored, signed amount: an ADJUSTMENT either way, a REVERSAL always negative. */
  signedAmountMinor: bigint
  direction: LedgerAdjustmentDirectionName
  reason: LedgerAdjustmentReasonName; note: string; fundingReceiptId: string | null
}

/** Validates and normalises a proposal. Pure, so every refusal is unit-tested without a database. */
export function parseLedgerAdjustmentProposal(body: unknown): LedgerAdjustmentProposal {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A request body is required')
  const b = body as Record<string, unknown>
  const requestId = typeof b.requestId === 'string' ? b.requestId.trim() : ''
  if (requestId.length < 8 || requestId.length > 80 || !ID.test(requestId)) throw bad('requestId must be 8 to 80 characters (letters, digits, . _ : -)')
  if (typeof b.kind !== 'string' || !(LEDGER_ADJUSTMENT_KINDS as readonly string[]).includes(b.kind)) throw bad(`kind must be one of ${LEDGER_ADJUSTMENT_KINDS.join(', ')}`)
  const kind = b.kind as LedgerAdjustmentKindName
  const agencyId = typeof b.agencyId === 'string' ? b.agencyId.trim() : ''
  if (!ID.test(agencyId)) throw bad('agencyId is required')
  const currency = typeof b.currency === 'string' ? b.currency.trim() : ''
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('currency must be an ISO-4217 alpha code in capitals')
  const amount = typeof b.amountMinor === 'string' ? b.amountMinor.trim() : ''
  if (!/^[1-9]\d{0,17}$/.test(amount)) throw bad('amountMinor must be a positive whole number of minor units (digits only)')
  const allowedReasons: readonly string[] = kind === 'REVERSAL' ? LEDGER_REVERSAL_REASONS : LEDGER_ADJUSTMENT_REASONS
  if (typeof b.reason !== 'string' || !allowedReasons.includes(b.reason)) throw bad(`reason for a ${kind} must be one of ${allowedReasons.join(', ')}`)
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if (note.length < 3 || note.length > 500 || CONTROL.test(note)) throw bad('note must be 3 to 500 printable characters')

  let direction: LedgerAdjustmentDirectionName
  let fundingReceiptId: string | null = null
  if (kind === 'REVERSAL') {
    if (b.direction !== undefined) throw bad('A REVERSAL always debits the account; omit direction')
    const receipt = typeof b.fundingReceiptId === 'string' ? b.fundingReceiptId.trim() : ''
    if (!ID.test(receipt)) throw bad('fundingReceiptId is required for a REVERSAL')
    direction = 'DEBIT'
    fundingReceiptId = receipt
  } else {
    if (typeof b.direction !== 'string' || !(LEDGER_ADJUSTMENT_DIRECTIONS as readonly string[]).includes(b.direction)) throw bad(`direction must be one of ${LEDGER_ADJUSTMENT_DIRECTIONS.join(', ')}`)
    if (b.fundingReceiptId !== undefined && b.fundingReceiptId !== null) throw bad('An ADJUSTMENT is not linked to a funding receipt; use a REVERSAL to take a payment back')
    direction = b.direction as LedgerAdjustmentDirectionName
  }
  const magnitude = BigInt(amount)
  return { requestId, kind, agencyId, currency, signedAmountMinor: direction === 'DEBIT' ? -magnitude : magnitude, direction, reason: b.reason as LedgerAdjustmentReasonName, note, fundingReceiptId }
}

/** A rejection reason (3 to 500 printable characters). */
export function parseAdjustmentDecisionReason(body: unknown): string {
  const reason = body && typeof body === 'object' && typeof (body as Record<string, unknown>).reason === 'string' ? ((body as Record<string, unknown>).reason as string).trim() : ''
  if (reason.length < 3 || reason.length > 500 || CONTROL.test(reason)) throw bad('reason must be 3 to 500 printable characters')
  return reason
}
