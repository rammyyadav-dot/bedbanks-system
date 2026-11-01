import { Injectable } from '@nestjs/common'
import { businessDate, parseSmartSearch, type DestinationResolution } from '@bedbanks/domain'
import type { SmartSearchDestination, SmartSearchParseResponse } from '@bedbanks/contracts'
import { DestinationResolverService } from './destination-resolver.service'

/**
 * Smart Search (ADR 0065): the deterministic parser plus a catalogue lookup of the destination text.
 * The pasted text is used only for this call: it is never stored, cached, audited or logged (it often holds guest names).
 */
@Injectable()
export class SmartSearchService {
  constructor(private readonly destinations: DestinationResolverService) {}

  async parse(tenantId: string, text: string, now = new Date()): Promise<SmartSearchParseResponse> {
    const today = businessDate(now)
    const parsed = parseSmartSearch(text, today)
    const matches = parsed.destinationText ? await this.destinations.search(tenantId, parsed.destinationText) : []
    const destination = pickDestination(parsed.destinationText, matches)
    const unresolved = destination ? parsed.unresolved.filter((field) => field !== 'destination') : [...new Set([...parsed.unresolved, 'destination' as const])]
    const notes = [...parsed.notes]
    if (parsed.destinationText && !destination) notes.push(`"${parsed.destinationText}" is not a city or hotel in your catalogue.`)
    return {
      today,
      ...(destination ? { destination } : {}),
      alternatives: matches.filter((match) => match !== destination).slice(0, 5),
      ...(parsed.destinationText && !destination ? { destinationText: parsed.destinationText } : {}),
      ...(parsed.checkIn ? { checkIn: parsed.checkIn, checkOut: parsed.checkOut, nights: parsed.nights } : {}),
      ...(parsed.starRatings ? { starRatings: parsed.starRatings } : {}),
      ...(parsed.rooms ? { rooms: parsed.rooms } : {}),
      ...(parsed.nationality ? { nationality: parsed.nationality } : {}),
      unresolved: unresolved.sort((a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b)),
      notes,
    }
  }
}

const FIELD_ORDER = ['destination', 'dates', 'occupancy', 'stars', 'nationality'] as const

/** An exact city or hotel name wins; otherwise the typeahead's best match, but only when it is unambiguous (a single match). */
function pickDestination(text: string | undefined, matches: DestinationResolution[]): SmartSearchDestination | undefined {
  if (!text || matches.length === 0) return undefined
  const folded = text.trim().toLocaleLowerCase('en-US')
  const exact = matches.find((match) => match.name.toLocaleLowerCase('en-US') === folded)
  if (exact) return exact
  const cities = matches.filter((match) => match.type === 'city')
  if (cities.length === 1) return cities[0]
  return matches.length === 1 ? matches[0] : undefined
}
