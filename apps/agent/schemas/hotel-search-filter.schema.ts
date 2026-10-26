import { z } from 'zod'
import { majorUnitsToMinor, minorUnitExponent } from '@bedbanks/money'
import { HOTEL_SEARCH_FILTER_LIMITS, type HotelSearchFilterIssue, type HotelSearchFilters } from '@bedbanks/contracts/agent'
import type { SearchCriteria } from '@bedbanks/domain'

/**
 * Runtime validation of hotel search filter parameters (query string, route params, persisted drafts).
 *
 * Every value arrives as untrusted text. Nothing is coerced with `Number()`/`parseFloat()` before a strict grammar has matched,
 * so `''`, `' '`, `'1e9'`, `'0x10'`, `'Infinity'` and `'-0'` can never turn into a quiet 0 or a huge number.
 *
 * - Prices are decimal strings in the major unit of `currency` and leave this module as integer minor units (CLAUDE.md invariant 3).
 * - Identity is never read here: `tenantId`, `agencyId` and every other unknown key is dropped (invariant 1).
 * - Text is normalised and checked against an allow-list. That is input hygiene only; the database defence stays bind parameters.
 */

const L = HOTEL_SEARCH_FILTER_LIMITS
export { HOTEL_SEARCH_FILTER_LIMITS }

const ONCE = 'Provide this parameter once.'
const PRICE_FORMAT = "Enter the price as a plain amount in the selected currency, using no more decimal places than that currency allows."

/** Blank and whitespace-only values mean "not provided". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional())

const text = (label: string) => optional(z.string({ error: ONCE }).max(L.maxRawTextLength, `${label} is too long.`))
const decimal = (grammar: RegExp, message: string) => optional(z.string({ error: ONCE }).trim().regex(grammar, message))

/** `stars=4,5`, `stars=4&stars=5` and `[4, 5]` are all accepted and flattened to individual tokens. */
function starTokens(value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  const parts = Array.isArray(value) ? value : [value]
  if (parts.length > 10) return parts
  return parts.flatMap((part) => (typeof part === 'string' ? part.split(',').map((token) => token.trim()) : typeof part === 'number' ? [String(part)] : [part]))
}
const stars = z.preprocess(
  starTokens,
  z.array(z.string().regex(/^[1-5]$/, 'Star ratings must be whole numbers from 1 to 5.'), { error: 'Star ratings must be whole numbers from 1 to 5.' })
    .max(10, 'Too many star ratings.').optional(),
)

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const ALLOWED_TEXT = /^[\p{L}\p{M}\p{N} '’.,&()/-]+$/u

/** NFKC-normalise, drop control and invisible formatting characters, collapse whitespace. Returns null when nothing safe remains. */
export function sanitizeSearchText(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = raw.normalize('NFKC').replace(/[\t\n\r\f\v]+/g, ' ').replace(CONTROL_OR_FORMAT, '').replace(/\s+/g, ' ').trim()
  if (value.length === 0) return { ok: false, message: 'Enter some text.' }
  if (value.length > L.maxTextLength) return { ok: false, message: `Use at most ${L.maxTextLength} characters.` }
  if (!ALLOWED_TEXT.test(value) || value.includes('--') || value.includes('..')) return { ok: false, message: 'Use letters, numbers, spaces and . , \' & ( ) / - only.' }
  return { ok: true, value }
}

const rawSchema = z.object({
  minPrice: decimal(/^\d{1,7}(\.\d{1,4})?$/, PRICE_FORMAT),
  maxPrice: decimal(/^\d{1,7}(\.\d{1,4})?$/, PRICE_FORMAT),
  currency: optional(z.string({ error: ONCE }).trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO 4217 code.')),
  stars,
  latitude: decimal(/^-?\d{1,2}(\.\d{1,7})?$/, 'Latitude must be a decimal between -90 and 90.'),
  longitude: decimal(/^-?\d{1,3}(\.\d{1,7})?$/, 'Longitude must be a decimal between -180 and 180.'),
  radius: decimal(/^\d{1,3}(\.\d{1,2})?$/, `Radius must be between 0 and ${L.maxRadiusKm} km.`),
  page: decimal(/^\d{1,5}$/, 'Page must be a positive whole number.'),
  limit: decimal(/^\d{1,4}$/, `Limit must be a whole number from 1 to ${L.maxLimit}.`),
  destination: text('Destination'),
  hotelName: text('Hotel name'),
})
// Unknown keys (tenantId, agencyId, tracking parameters) are stripped by z.object, never trusted.

export const hotelSearchFilterSchema = rawSchema.transform((raw, ctx): HotelSearchFilters => {
  const fail = (path: string, message: string) => { ctx.addIssue({ code: 'custom', path: [path], message }) }
  const out: HotelSearchFilters = { page: L.defaultPage, limit: L.defaultLimit, offset: 0 }

  if (raw.stars?.length) out.stars = [...new Set(raw.stars.map(Number))].sort((a, b) => a - b)

  if (raw.minPrice !== undefined || raw.maxPrice !== undefined) {
    if (raw.currency === undefined) fail('currency', 'Choose a currency for the price range.')
    else {
      let exponent = 0
      try { exponent = minorUnitExponent(raw.currency) } catch { fail('currency', 'This currency is not supported.') }
      const ceiling = L.maxPriceMajor * 10 ** exponent
      const toMinor = (field: 'minPrice' | 'maxPrice') => {
        const input = raw[field]
        if (input === undefined) return undefined
        try {
          const minor = majorUnitsToMinor(input, raw.currency as string)
          if (minor > ceiling) { fail(field, `Prices above ${L.maxPriceMajor.toLocaleString('en-GB')} ${raw.currency} are not supported.`); return undefined }
          return minor
        } catch { fail(field, PRICE_FORMAT); return undefined }
      }
      const min = toMinor('minPrice')
      const max = toMinor('maxPrice')
      if (min !== undefined && max !== undefined && max < min) fail('maxPrice', 'The maximum price must be at least the minimum price.')
      if (min !== undefined) out.minPriceMinor = min
      if (max !== undefined) out.maxPriceMinor = max
      out.currency = raw.currency
    }
  } else if (raw.currency !== undefined) out.currency = raw.currency

  if ((raw.latitude === undefined) !== (raw.longitude === undefined)) fail(raw.latitude === undefined ? 'latitude' : 'longitude', 'Latitude and longitude must be given together.')
  else if (raw.latitude !== undefined && raw.longitude !== undefined) {
    // Coordinates are geometry, not money: the strict grammar above has already matched, so Number() is safe here.
    const lat = Number(raw.latitude)
    const lng = Number(raw.longitude)
    if (lat < -90 || lat > 90) fail('latitude', 'Latitude must be between -90 and 90.')
    else out.latitude = lat
    if (lng < -180 || lng > 180) fail('longitude', 'Longitude must be between -180 and 180.')
    else out.longitude = lng
  }
  if (raw.radius !== undefined) {
    const radius = Number(raw.radius)
    if (radius <= 0 || radius > L.maxRadiusKm) fail('radius', `Radius must be greater than 0 and at most ${L.maxRadiusKm} km.`)
    else if (raw.latitude === undefined || raw.longitude === undefined) fail('radius', 'A radius needs a latitude and longitude.')
    else out.radiusKm = radius
  }

  if (raw.page !== undefined) {
    const page = Number(raw.page)
    if (page < 1 || page > L.maxPage) fail('page', `Page must be between 1 and ${L.maxPage}.`)
    else out.page = page
  }
  if (raw.limit !== undefined) {
    const limit = Number(raw.limit)
    if (limit < 1 || limit > L.maxLimit) fail('limit', `Limit must be between 1 and ${L.maxLimit}.`)
    else out.limit = limit
  }
  out.offset = (out.page - 1) * out.limit

  for (const field of ['destination', 'hotelName'] as const) {
    const value = raw[field]
    if (value === undefined) continue
    const clean = sanitizeSearchText(value)
    if (clean.ok) out[field] = clean.value
    else fail(field, clean.message)
  }
  return out
})

/** `status` is the HTTP status a route handler should answer with. Messages never echo the rejected input. */
export type HotelSearchFilterResult =
  | { ok: true; value: HotelSearchFilters }
  | { ok: false; status: 400; errors: HotelSearchFilterIssue[] }

const SEARCH_FILTER_KEYS = ['minPrice', 'maxPrice', 'currency', 'stars', 'latitude', 'longitude', 'radius', 'page', 'limit', 'destination', 'hotelName'] as const

/** Reads only the known keys, so a repeated key becomes an array (and is then refused) and nothing else is carried along. */
export function searchParamsToRecord(params: URLSearchParams): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {}
  for (const key of SEARCH_FILTER_KEYS) {
    const values = params.getAll(key)
    if (values.length === 1) record[key] = values[0]
    else if (values.length > 1) record[key] = values.slice(0, 11)
  }
  return record
}

/** Never throws. Accepts a Next.js `searchParams` object, a `URLSearchParams`, or any unknown value. */
export function parseHotelSearchFilters(input: unknown): HotelSearchFilterResult {
  try {
    const source = input instanceof URLSearchParams ? searchParamsToRecord(input) : input
    const parsed = hotelSearchFilterSchema.safeParse(source)
    if (parsed.success) return { ok: true, value: parsed.data }
    return { ok: false, status: 400, errors: parsed.error.issues.map((issue) => ({ field: String(issue.path[0] ?? 'query'), message: issue.message })) }
  } catch {
    return { ok: false, status: 400, errors: [{ field: 'query', message: 'The search filters could not be read.' }] }
  }
}

/** Maps validated filters onto the domain request shape. */
export function toCriteriaFilters(value: HotelSearchFilters): NonNullable<SearchCriteria['filters']> {
  return {
    ...(value.stars?.length ? { starRatings: value.stars } : {}),
    ...(value.minPriceMinor !== undefined ? { minPriceMinor: value.minPriceMinor } : {}),
    ...(value.maxPriceMinor !== undefined ? { maxPriceMinor: value.maxPriceMinor } : {}),
  }
}
