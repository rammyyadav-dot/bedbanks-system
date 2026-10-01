export type DestinationSuggestion = {
  id: string
  kind: 'city' | 'destination-text'
  label: string
  detail: string
  value: string
}

const dubai: DestinationSuggestion = {
  id: 'city-dubai',
  kind: 'city',
  label: 'Dubai',
  detail: 'United Arab Emirates · Searchable city',
  value: 'Dubai',
}

/** Suggestions follow the destination-name match. Hotel, area, landmark, and airport types are not offered. */
export function destinationSuggestions(query: string): DestinationSuggestion[] {
  const trimmed = query.trim().replace(/\s+/g, ' ')
  const folded = trimmed.toLocaleLowerCase()
  const suggestions: DestinationSuggestion[] = []
  if (!folded || 'dubai'.includes(folded) || folded.includes('dubai')) suggestions.push(dubai)
  if (trimmed && folded !== 'dubai') {
    suggestions.push({
      id: `text:${folded}`,
      kind: 'destination-text',
      label: trimmed,
      detail: 'Destination text. Matches the hotel destination field only.',
      value: trimmed,
    })
  }
  return suggestions
}
