import { cityDestinationId } from '@bedbanks/domain/search-offers'
import type { DestinationRef } from '@bedbanks/domain'

export type DestinationSuggestion = {
  id: string
  kind: 'city'
  label: string
  detail: string
  value: string
  ref: DestinationRef
}

const dubaiId = cityDestinationId('AE', 'Dubai')

const dubai: DestinationSuggestion = {
  id: dubaiId,
  kind: 'city',
  label: 'Dubai',
  detail: 'United Arab Emirates · Canonical city',
  value: 'Dubai',
  ref: { type: 'city', id: dubaiId, countryCode: 'AE' },
}

/** Local hints are canonical ids only. Typed text is not a destination until a city or hotel is selected. */
export function destinationSuggestions(query: string): DestinationSuggestion[] {
  const folded = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  if (!folded || 'dubai'.includes(folded) || folded.includes('dubai')) return [dubai]
  return []
}

export function canSubmitDestination(ref: DestinationRef | null | undefined): ref is DestinationRef {
  if (!ref) return false
  if (ref.type === 'city') return ref.id.startsWith(`city:${ref.countryCode}:`) && ref.id.length > 8
  return ref.type === 'hotel' && ref.id.trim().length > 0
}
