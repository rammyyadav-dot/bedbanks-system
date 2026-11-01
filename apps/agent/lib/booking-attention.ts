const UNCERTAIN = new Set(['UNKNOWN', 'SENDING', 'PREPARED'])

export type AgentBookingFace = {
  label: string
  attention: boolean
  message: string
}

/**
 * Agent-facing booking language. Internal supplier states stay on the server.
 * An uncertain supplier outcome is confirmation pending, never a failed booking.
 */
export function agentFacingBooking(status: string, mutationStatus?: string | null): AgentBookingFace {
  if (status === 'PENDING' && mutationStatus && UNCERTAIN.has(mutationStatus)) {
    return {
      label: 'Confirmation pending',
      attention: true,
      message: 'We are verifying this reservation with the supplier. Do not submit another booking for the same stay yet.',
    }
  }
  if (status === 'PENDING') {
    return {
      label: 'Pending',
      attention: true,
      message: 'This booking is not confirmed. Wait for this record to resolve before booking the same stay again.',
    }
  }
  if (status === 'CONFIRMED') {
    return { label: 'Confirmed', attention: false, message: 'This booking is confirmed.' }
  }
  if (status === 'CANCELLED') {
    return { label: 'Cancelled', attention: false, message: 'This booking is cancelled.' }
  }
  if (status === 'FAILED') {
    return { label: 'Not confirmed', attention: true, message: 'This booking was not confirmed.' }
  }
  return { label: 'Status unavailable', attention: true, message: 'The booking status could not be shown.' }
}

/** A supplier reference is shown only on a confirmed booking with an acknowledged reference. */
export function supplierReferenceForAgent(status: string, mutation: { status: string; supplierReference: string | null } | null | undefined): string | null {
  if (status !== 'CONFIRMED' || !mutation?.supplierReference) return null
  if (mutation.status !== 'ACKNOWLEDGED' && mutation.status !== 'RESOLVED') return null
  return mutation.supplierReference
}
