import type { OfferRecheckResult } from '../types/hotel'

export function recheckOutcomeTitle(status: OfferRecheckResult['status']) {
  const titles: Record<OfferRecheckResult['status'], string> = {
    rechecked: 'Offer rechecked',
    price_changed: 'Price updated',
    unavailable: 'This offer is no longer available',
    offer_expired: 'This rate has expired',
    mapping_invalid: 'This offer could not be verified',
    provider_unavailable: 'Recheck is temporarily unavailable',
    rejected: 'This offer could not be verified',
    auth_required: 'Sign in again',
    access_denied: 'Recheck denied',
  }
  return titles[status]
}

export function recheckOutcomeMessage(status: OfferRecheckResult['status'], bookingEnabled: boolean) {
  const messages: Record<OfferRecheckResult['status'], string> = {
    rechecked: bookingEnabled
      ? 'Current price and availability have been verified.'
      : 'Current price and availability have been verified. Booking activation is not available for this account.',
    price_changed: 'The price changed since this search. Accept the current price to recheck it, or choose another offer.',
    unavailable: 'Availability changed since your search. No inventory was allocated.',
    offer_expired: 'Refresh the latest rates to continue. No inventory was allocated.',
    mapping_invalid: 'The hotel, room or commercial mapping could not be verified. No inventory was allocated.',
    provider_unavailable: 'The supplier could not be reached safely. No inventory was allocated. Try the recheck again.',
    rejected: 'The supplier response could not be verified. No inventory was allocated.',
    auth_required: 'Your session expired. Sign in again.',
    access_denied: 'You do not have permission to recheck this offer.',
  }
  return messages[status]
}
