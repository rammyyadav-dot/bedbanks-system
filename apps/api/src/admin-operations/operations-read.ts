import { ServiceUnavailableException } from '@nestjs/common'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'

/**
 * The runtime database role is deliberately SELECT-only on supply tables and has no grants on bookings, ledger,
 * holds, documents or connectors (ADR 0008). A 42501 there is a privilege boundary, not an empty result:
 * surface it as a distinct, machine-readable 503 so the Admin never renders it as "no data".
 */
export async function guardedRead<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isBookingReadDenied(error)) {
      throw new ServiceUnavailableException({
        message: 'This operations view is not readable by the API database role. Grants must be reviewed by a human; see ADR 0011.',
        code: OPERATIONS_READ_DENIED,
      })
    }
    throw error
  }
}

/** Like guardedRead, but returns an explicit "unavailable" section (for dashboards that mix readable and unreadable data). */
export async function sectionRead<T>(work: () => Promise<T>): Promise<{ state: 'available'; data: T } | { state: 'unavailable'; reason: typeof OPERATIONS_READ_DENIED }> {
  try {
    return { state: 'available', data: await work() }
  } catch (error) {
    if (isBookingReadDenied(error)) return { state: 'unavailable', reason: OPERATIONS_READ_DENIED }
    throw error
  }
}

export const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
export const day = (value: Date): string => value.toISOString().slice(0, 10)
