import type { ExtranetBookingQuery, ExtranetBookingStatus } from '@bedbanks/contracts'

export const BOOKING_STATUS_OPTIONS: ExtranetBookingStatus[] = ['PENDING_SUPPLIER', 'ON_REQUEST', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CANCELLED', 'CHECKED_OUT', 'NO_SHOW', 'REJECTED', 'FAILED']

const DAY = /^\d{4}-\d{2}-\d{2}$/
const REFERENCE = /^[A-Za-z0-9-]{3,40}$/
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Reads the portal URL into API filters. Only known keys are read and each is validated; an invalid value is dropped and reported, never forwarded.
 * Supplier and tenant are not filters: scope comes from the authenticated session.
 */
export function bookingFilters(params: Record<string, string | string[] | undefined>): { values: ExtranetBookingQuery; ignored: string[] } {
  const values: ExtranetBookingQuery = {}
  const ignored: string[] = []
  const status = first(params.status)
  if (status) (BOOKING_STATUS_OPTIONS as string[]).includes(status) ? (values.status = status as ExtranetBookingStatus) : ignored.push('status')
  for (const key of ['checkInFrom', 'checkInTo'] as const) {
    const value = first(params[key])
    if (value) DAY.test(value) ? (values[key] = value) : ignored.push(key)
  }
  const reference = first(params.reference)
  if (reference) REFERENCE.test(reference) ? (values.reference = reference) : ignored.push('reference')
  const cursor = first(params.cursor)
  if (cursor) CURSOR.test(cursor) ? (values.cursor = cursor) : ignored.push('cursor')
  if (values.checkInFrom && values.checkInTo && values.checkInFrom > values.checkInTo) {
    delete values.checkInFrom
    delete values.checkInTo
    ignored.push('arrival range')
  }
  return { values, ignored }
}

export function filtersToQuery(values: ExtranetBookingQuery): string {
  const params = new URLSearchParams()
  for (const key of ['reference', 'status', 'checkInFrom', 'checkInTo', 'cursor'] as const) if (values[key]) params.set(key, String(values[key]))
  return params.toString()
}
