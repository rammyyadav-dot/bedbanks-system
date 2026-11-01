import type { BookingStatus } from '@prisma/client'

/**
 * The Agent API keeps the four-value booking vocabulary it had before the ten-value lifecycle (ADR 0039). Widening what Agents see is a
 * separate, explicit contract change; until then the operational statuses collapse as below, and nothing here ever makes a booking look
 * more settled than it is:
 *   PENDING   awaiting the supplier or an operator (PENDING_SUPPLIER, ON_REQUEST, CANCEL_REQUESTED: a cancel in flight is not "confirmed", so it is not cancellable again)
 *   CONFIRMED a confirmed stay, including one with an open amendment, a completed stay and a no-show
 *   CANCELLED cancelled
 *   FAILED    failed or rejected
 */
export type AgentBookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED'
export const AGENT_BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'] as const satisfies readonly AgentBookingStatus[]

const TO_AGENT: Record<BookingStatus, AgentBookingStatus> = {
  PENDING_SUPPLIER: 'PENDING', ON_REQUEST: 'PENDING', CANCEL_REQUESTED: 'PENDING',
  CONFIRMED: 'CONFIRMED', AMEND_REQUESTED: 'CONFIRMED', CHECKED_OUT: 'CONFIRMED', NO_SHOW: 'CONFIRMED',
  CANCELLED: 'CANCELLED', FAILED: 'FAILED', REJECTED: 'FAILED',
}
export const toAgentBookingStatus = (status: BookingStatus): AgentBookingStatus => TO_AGENT[status]

/** The ten-value statuses an Agent filter value stands for. */
export function statusesForAgentFilter(value: AgentBookingStatus): BookingStatus[] {
  return (Object.keys(TO_AGENT) as BookingStatus[]).filter((status) => TO_AGENT[status] === value)
}
export const isAgentBookingStatus = (value: string): value is AgentBookingStatus => (AGENT_BOOKING_STATUSES as readonly string[]).includes(value)
