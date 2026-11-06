import type { BookingAccessView } from '@bedbanks/contracts'
import type { OpsFailure } from './ops-state'

const DROP_ACCESS = new Set<OpsFailure>(['forbidden', 'unauthenticated', 'denied'])

/** A permission, session, or privilege failure must not keep the previous agency's controls on screen. */
export function dropsBookingAccess(failure: OpsFailure): boolean {
  return DROP_ACCESS.has(failure)
}

/** The agency filter is an operator control. It stays hidden until the list says this caller is an operator. */
export function showAgencyFilter(access: Pick<BookingAccessView, 'level'> | null): boolean {
  return access?.level === 'OPERATOR'
}
