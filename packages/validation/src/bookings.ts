import { z } from 'zod'

const minorUnits = z.string().regex(/^-?\d+$/, 'Expected integer minor units as a string')
const iso4217 = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO-4217 code')

export const bookingListQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  status: z.string().min(1).max(32).optional(),
}).strict()

export const offerHoldRequestSchema = z.object({
  searchId: z.string().min(1).max(128),
  expectedCurrency: iso4217,
  expectedSellAmountMinor: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(128),
}).strict()

export const leadGuestSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
}).strict()

export const confirmBookingRequestSchema = z.object({
  bookingId: z.string().min(1).max(64),
  ccEmails: z.array(z.string().email().max(254)).max(3).optional(),
}).strict()

export const bookingMoneyViewSchema = z.object({
  currency: iso4217,
  totalMinor: minorUnits,
}).strict()
