import { z } from 'zod'
import { DISTRIBUTION_SEARCH_LIMITS as L, type DistributionSearchRequest } from '@bedbanks/contracts'

/**
 * Runtime validation of the B2B distribution search request (ADR 0075). The type assertions at the end of the file
 * make any drift between this schema and the `@bedbanks/contracts` interface a compile error.
 *
 * Objects are strict: an unknown key such as `tenantId` or `agencyId` is a validation error, not silently dropped,
 * so a partner learns immediately that identity comes from its credential (invariant 1).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

function utcDay(value: string): number | null {
  if (!ISO_DATE.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value) ? time : null
}

const isoDate = z.string().refine((v) => utcDay(v) !== null, 'Expected a real calendar date (YYYY-MM-DD)')
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Expected an fBeds id')
const currency = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO-4217 code')
const minorUnits = z.string().regex(/^(0|[1-9]\d{0,17})$/, 'Expected non-negative integer minor units as a string')
const latitude = z.string().regex(/^-?(90(\.0{1,7})?|[1-8]?\d(\.\d{1,7})?)$/, 'Expected latitude in decimal degrees')
const longitude = z.string().regex(/^-?(180(\.0{1,7})?|(1[0-7]\d|[1-9]?\d)(\.\d{1,7})?)$/, 'Expected longitude in decimal degrees')

export const distributionMoneySchema = z.object({ amountMinor: minorUnits, currency }).strict()

export const distributionGeoBoxSchema = z.object({ north: latitude, south: latitude, east: longitude, west: longitude }).strict()
  // Coordinates are geometry, not money; comparing them as numbers is safe. Boxes crossing the antimeridian are refused.
  .refine((b) => Number(b.north) > Number(b.south), { message: 'north must be greater than south', path: ['north'] })
  .refine((b) => Number(b.east) > Number(b.west), { message: 'east must be greater than west', path: ['east'] })

export const distributionDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('city'), cityId: id }).strict(),
  z.object({
    type: z.literal('hotels'),
    hotelIds: z.array(id).min(1).max(L.maxHotelIds).refine((ids) => new Set(ids).size === ids.length, 'hotelIds must be unique'),
  }).strict(),
  z.object({ type: z.literal('geo_box'), box: distributionGeoBoxSchema }).strict(),
])

export const distributionRoomSchema = z.object({
  adults: z.number().int().min(1).max(L.maxAdultsPerRoom),
  childAges: z.array(z.number().int().min(0).max(L.maxChildAge)).max(L.maxChildrenPerRoom),
}).strict()

const boardBasis = z.enum(['RO', 'BB', 'HB', 'FB', 'AI'])

export const distributionSearchRequestSchema = z.object({
  checkIn: isoDate,
  checkOut: isoDate,
  destination: distributionDestinationSchema,
  rooms: z.array(distributionRoomSchema).min(1).max(L.maxRooms),
  nationality: z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 code'),
  currency,
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Expected a BCP 47 language tag').max(35).optional(),
  filters: z.object({
    starRatings: z.array(z.number().int().min(1).max(5)).min(1).max(5).optional(),
    boardBasis: z.array(boardBasis).min(1).max(5).optional(),
    refundableOnly: z.boolean().optional(),
    maxTotal: distributionMoneySchema.optional(),
  }).strict().optional(),
  sort: z.object({ by: z.enum(['price', 'stars', 'name']), direction: z.enum(['asc', 'desc']) }).strict().optional(),
  page: z.object({
    size: z.number().int().min(1).max(L.maxPageSize).optional(),
    cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, 'Expected an opaque cursor').optional(),
  }).strict().optional(),
}).strict().superRefine((request, ctx) => {
  const checkIn = utcDay(request.checkIn)
  const checkOut = utcDay(request.checkOut)
  if (checkIn !== null && checkOut !== null) {
    const nights = (checkOut - checkIn) / DAY_MS
    if (nights < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOut'], message: 'checkOut must be after checkIn' })
    else if (nights > L.maxNights) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOut'], message: `A stay is at most ${L.maxNights} nights` })
  }
  const maxTotal = request.filters?.maxTotal
  if (maxTotal && maxTotal.currency !== request.currency) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', 'maxTotal', 'currency'], message: 'maxTotal must be in the requested currency' })
  }
})

// Compile-time contract parity: the schema output and the published interface must be the same type.
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const contractParity: Exact<z.infer<typeof distributionSearchRequestSchema>, DistributionSearchRequest> = true
void contractParity
