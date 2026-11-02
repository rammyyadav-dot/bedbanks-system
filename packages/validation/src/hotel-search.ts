import { z } from 'zod'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const MAX_NIGHTS = 30

function utcDay(value: string): number | null {
  if (!ISO_DATE.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value) ? time : null
}

const isoDate = z.string().refine((v) => utcDay(v) !== null, 'Expected a real calendar date (YYYY-MM-DD)')

const searchFiltersSchema = z.object({
  starRatings: z.array(z.number().int().min(1).max(5)).max(5).optional(),
  boardBasisIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  refundableOnly: z.boolean().optional(),
  minPriceMinor: z.number().int().min(0).optional(),
  maxPriceMinor: z.number().int().min(0).optional(),
  propertyTypes: z.array(z.string().min(1).max(64)).max(20).optional(),
  brands: z.array(z.string().min(1).max(64)).max(20).optional(),
}).strict()

/**
 * Agent hotel search body for POST /api/v1/agent/search.
 * Price bounds are integer minor units (invariant 3). Tenant identity is never accepted here.
 */
export const hotelSearchSchema = z.object({
  destination: z.string().trim().min(1).max(200),
  checkIn: isoDate,
  checkOut: isoDate,
  rooms: z.number().int().min(1).max(100),
  adults: z.number().int().min(1).max(800),
  children: z.number().int().min(0).max(800),
  childAges: z.array(z.number().int().min(0).max(17)).max(800),
  nationality: z.string().regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 code'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO-4217 code'),
  canonicalHotelIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  sort: z.enum(['default', 'price', 'stars', 'name']).optional(),
  destinationRef: z.object({
    type: z.enum(['city', 'hotel']),
    id: z.string().min(1).max(64),
    countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  }).strict().optional(),
  roomStays: z.array(z.object({
    adults: z.number().int().min(1).max(8),
    children: z.array(z.object({ age: z.number().int().min(0).max(17) }).strict()).max(8),
  }).strict()).max(100).optional(),
  filters: searchFiltersSchema.optional(),
}).strict().superRefine((request, ctx) => {
  const checkIn = utcDay(request.checkIn)
  const checkOut = utcDay(request.checkOut)
  if (checkIn !== null && checkOut !== null) {
    const nights = (checkOut - checkIn) / DAY_MS
    if (nights < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOut'], message: 'checkOut must be after checkIn' })
    else if (nights > MAX_NIGHTS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkOut'], message: `A stay is at most ${MAX_NIGHTS} nights` })
  }
  if (request.childAges.length !== request.children) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['childAges'], message: 'childAges must list one age per child' })
  }
  if (request.filters?.minPriceMinor !== undefined && request.filters.maxPriceMinor !== undefined
    && request.filters.minPriceMinor > request.filters.maxPriceMinor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', 'maxPriceMinor'], message: 'maxPriceMinor must be at least minPriceMinor' })
  }
})

export type HotelSearchRequest = z.infer<typeof hotelSearchSchema>
