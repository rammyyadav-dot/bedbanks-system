import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { departmentPermissions } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccessGuard, REQUIRED_BOOKING_ACTION } from './booking-access.guard'
import { BookingOpsController } from './booking-ops.controller'

const proto = BookingOpsController.prototype as unknown as Record<string, unknown>
const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function').sort()
const declared = (n: string) => Reflect.getMetadata(REQUIRED_BOOKING_ACTION, proto[n] as object) as string[] | undefined
const known = new Set<string>(Object.values(departmentPermissions))
const EXPECTED: Record<string, string> = { list: 'booking.ops.view', assignees: 'booking.ops.view', item: 'booking.ops.view', assign: 'booking.ops.assign', acknowledge: 'booking.ops.assign', escalate: 'booking.ops.escalate', note: 'booking.ops.note', clear: 'booking.ops.resolve', answer: 'booking.ops.resolve' }

describe('BookingOpsController authorization wiring (ADR 0039, Phase 4)', () => {
  it('has exactly the documented handlers', () => expect(handlers).toEqual(Object.keys(EXPECTED).sort()))
  it.each(Object.entries(EXPECTED))('%s declares exactly %s and runs the booking access guard', (name, key) => {
    expect(declared(name)).toEqual([key]); expect(known.has(key)).toBe(true)
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[name] as object)).toEqual([BookingAccessGuard])
  })
  it('sits behind session authentication and tenant context at controller level, and the permission catalogue enforces each ops key', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BookingOpsController)).toEqual([SessionAuthGuard, TenantContextGuard])
  })
})
