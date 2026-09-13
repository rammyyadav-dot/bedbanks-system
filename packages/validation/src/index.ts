import { z } from 'zod'

export const paginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
})

export const hotelSearchSchema = z.object({
  city: z.string().trim().min(1),
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
})
