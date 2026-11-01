// Pure helpers for the advisory hotel-mapping suggestions (GET /supply/mappings/hotels/suggestions). A suggestion never creates or
// approves a mapping: staff still choose a hotel and create a pending mapping that a checker approves (ADR 0004).
import type { HotelMappingSuggestion, HotelMappingSuggestionQuery, HotelMappingSuggestions } from '@bedbanks/contracts'

export const SUGGESTIONS_PATH = '/supply/mappings/hotels/suggestions'

/** Blank fields are omitted. Returns null until the query meets the server's minimum (a name of at least two characters). */
export function suggestionPath(query: HotelMappingSuggestionQuery): string | null {
  const name = query.name?.trim() ?? ''
  if (name.length < 2) return null
  const params = new URLSearchParams({ name })
  for (const key of ['address', 'city'] as const) {
    const value = query[key]?.trim()
    if (value) params.set(key, value)
  }
  const country = query.countryCode?.trim()
  if (country) params.set('countryCode', country.toUpperCase())
  return `${SUGGESTIONS_PATH}?${params.toString()}`
}

export const TIER_LABEL: Record<HotelMappingSuggestion['tier'], string> = {
  EXACT: 'Exact identity',
  HIGH_CONFIDENCE: 'High confidence',
  REVIEW_REQUIRED: 'Needs review',
}

const REASON_LABEL: Record<string, string> = {
  normalized_identity: 'Same normalized name, address and city',
  name_similarity: 'Very similar name',
  address_similarity: 'Very similar address',
  vector_similarity: 'Similar overall description',
  geo_proximity: 'Within 500 m',
  geo_conflict: 'More than 5 km apart',
  city_mismatch: 'Different city',
  ambiguous_candidate: 'Another candidate scores almost the same',
}
export const reasonLabel = (reason: string): string => REASON_LABEL[reason] ?? reason.replace(/_/g, ' ')

export type SuggestionView =
  | { kind: 'index-empty' }
  | { kind: 'none' }
  | { kind: 'matches'; suggestions: HotelMappingSuggestion[] }

/** An unpopulated index is shown as such, never as "no match" (it would hide a gap in the data). */
export function suggestionView(result: HotelMappingSuggestions): SuggestionView {
  if (!result.indexReady) return { kind: 'index-empty' }
  return result.suggestions.length === 0 ? { kind: 'none' } : { kind: 'matches', suggestions: result.suggestions }
}
