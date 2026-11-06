import type { HotelSearchResult } from '../types/hotel'

export type SearchOutcomeCopy = {
  banner: string
  title: string
  body: string
  /** A retry is offered only when the same search may succeed without a permission or session change. */
  retry: boolean
}

const COPY: Record<HotelSearchResult['status'], SearchOutcomeCopy> = {
  available: {
    banner: '',
    title: '',
    body: '',
    retry: false,
  },
  partial: {
    banner: 'Some hotel inventory is temporarily unavailable. We could not retrieve rates from one inventory source. Your other available results are still shown.',
    title: '',
    body: '',
    retry: false,
  },
  empty: {
    banner: 'No hotels matched this search. This is not a supplier outage.',
    title: 'No hotels matched this search.',
    body: 'Change the dates, broaden the destination, or clear filters. This is not a supplier outage.',
    retry: true,
  },
  mapping_unavailable: {
    banner: 'Supplier offer mapping could not be verified. No rate is displayed.',
    title: 'This offer is not available for booking yet',
    body: 'The supplier offer could not be verified against the fabBeds hotel and room catalogue.',
    retry: true,
  },
  access_denied: {
    banner: 'You do not have permission to search this workspace. No hotels are shown.',
    title: 'Search denied',
    body: 'You do not have permission to search this workspace. No hotels are shown.',
    retry: false,
  },
  agency_suspended: {
    banner: '',
    title: '',
    body: '',
    retry: false,
  },
  auth_required: {
    banner: 'Your session expired. Sign in again. No hotels are shown.',
    title: 'Sign in again',
    body: 'Your session expired. No hotels are shown.',
    retry: false,
  },
  destination_unavailable: {
    banner: 'This destination is no longer in the canonical catalogue. No hotels are shown.',
    title: 'Destination unavailable',
    body: 'This destination is no longer in the canonical catalogue. Choose another destination. No hotels are shown.',
    retry: false,
  },
  provider_unavailable: {
    banner: 'The search did not finish. Nothing was booked. Run the search again before using a price.',
    title: 'Search did not finish',
    body: 'The search timed out or the supplier did not answer. Nothing was booked. Run the search again before using a price.',
    retry: true,
  },
}

export function searchOutcome(status: HotelSearchResult['status']): SearchOutcomeCopy {
  return COPY[status]
}
