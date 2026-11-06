export type RecoveryItem = { holdId: string; bookingId: string | null; outcome: string }

const OUTCOME_TEXT: Record<string, string> = {
  reconciled: 'An interrupted attempt was closed and its inventory was returned.',
  orphan_hold_released: 'An unused hold was released.',
  prebooked_awaiting_confirmation: 'A fulfilled supplier booking is still inside its confirmation window. It was left in place.',
  prebook_expired: 'A prebook that was never confirmed was closed and its inventory was returned.',
  manual_review_required: 'A supplier outcome is still unknown. Nothing was released.',
  booking_not_pending: 'A booking had already moved on. It was left unchanged.',
  failed: 'Recovery could not finish one hold. Run recovery again.',
}

/** Agent-facing lines for one recovery run. Unknown outcomes stay visible and are not described as success. */
export function recoveryLines(items: readonly RecoveryItem[]): string[] {
  if (items.length === 0) return ['No interrupted holds were old enough to recover.']
  return items.map((item) => {
    const text = OUTCOME_TEXT[item.outcome] ?? `Recovery reported ${item.outcome}.`
    const booking = item.bookingId ? `Booking ${item.bookingId}` : `Hold ${item.holdId}`
    return `${booking}: ${text}`
  })
}
