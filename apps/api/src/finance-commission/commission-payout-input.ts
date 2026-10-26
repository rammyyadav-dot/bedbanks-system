import { BadRequestException } from '@nestjs/common'
import { COMMISSION_PAYOUT_FAILURE } from '@bedbanks/contracts'

const bad = (message: string) => new BadRequestException({ message, code: COMMISSION_PAYOUT_FAILURE.invalid })
const CONTROL = /[\u0000-\u001f\u007f]/
const ID = /^[A-Za-z0-9_.:-]{1,80}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export interface CommissionPayoutProposal { requestId: string; agencyId: string; periodStart: string; periodEnd: string; currency: string }

/**
 * Validates and normalises a proposal. Pure, so every refusal is unit-tested without a database.
 * Gross booked volume is never accepted here: it is derived server-side from posted booking revenue (ADR 0098 update), so a caller cannot inflate its own commission.
 */
export function parseCommissionPayoutProposal(body: unknown): CommissionPayoutProposal {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A request body is required')
  const b = body as Record<string, unknown>
  const requestId = typeof b.requestId === 'string' ? b.requestId.trim() : ''
  if (requestId.length < 8 || requestId.length > 80 || !ID.test(requestId)) throw bad('requestId must be 8 to 80 characters (letters, digits, . _ : -)')
  const agencyId = typeof b.agencyId === 'string' ? b.agencyId.trim() : ''
  if (!ID.test(agencyId)) throw bad('agencyId is required')
  const periodStart = typeof b.periodStart === 'string' ? b.periodStart.trim() : ''
  const periodEnd = typeof b.periodEnd === 'string' ? b.periodEnd.trim() : ''
  if (!DATE.test(periodStart) || !DATE.test(periodEnd) || Number.isNaN(Date.parse(periodStart)) || Number.isNaN(Date.parse(periodEnd))) throw bad('periodStart and periodEnd must be YYYY-MM-DD dates')
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) throw bad('periodEnd must be after periodStart')
  const currency = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : ''
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('currency must be an ISO-4217 alpha code')
  if (CONTROL.test(JSON.stringify(b))) throw bad('request body contains control characters')
  return { requestId, agencyId, periodStart, periodEnd, currency }
}

/** A rejection reason (3 to 500 printable characters). */
export function parseDecisionReason(body: unknown): string {
  const reason = body && typeof body === 'object' && typeof (body as Record<string, unknown>).reason === 'string' ? ((body as Record<string, unknown>).reason as string).trim() : ''
  if (reason.length < 3 || reason.length > 500 || CONTROL.test(reason)) throw bad('reason must be 3 to 500 printable characters')
  return reason
}
