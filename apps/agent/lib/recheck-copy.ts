import type { OfferRecheckResult } from '../types/hotel'

export function recheckOutcomeMessage(status: OfferRecheckResult['status'], bookingEnabled: boolean) {
  const tail = bookingEnabled ? '' : ' Booking remains disabled.'
  const messages: Record<OfferRecheckResult['status'], string> = {
    rechecked: `Rate rechecked against current contracted inventory.${tail}`,
    price_changed: 'The authoritative total changed. The quoted amount stays in place until you accept the new total.',
    unavailable: `The rate is no longer available. No inventory was allocated.${tail}`,
    offer_expired: `The offer expired. Search again for a current rate.${tail}`,
    mapping_invalid: 'The hotel, room or commercial mapping could not be verified. No inventory was allocated.',
    provider_unavailable: 'The supplier could not be reached safely. No inventory was allocated. Try the recheck again.',
    rejected: 'The supplier response could not be verified. No inventory was allocated.',
    auth_required: 'Your session expired. Sign in again.',
    access_denied: 'You do not have permission to recheck this offer.',
  }
  return messages[status]
}
