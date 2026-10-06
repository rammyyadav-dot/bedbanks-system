import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { BookingAccessGuard, REQUIRED_BOOKING_ACTION } from './booking-access.guard'
import { BookingActionsController } from './booking-actions.controller'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard } from '../agent/tenant-context.guard'
import { departmentPermissions } from '@bedbanks/contracts'

const proto = BookingActionsController.prototype as unknown as Record<string, unknown>
const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
const declared = (n: string) => Reflect.getMetadata(REQUIRED_BOOKING_ACTION, proto[n] as object) as string[] | undefined
const known = new Set<string>([...Object.values(departmentPermissions), 'booking.cancel'])

describe('BookingActionsController authorization wiring (ADR 0039, Phase 2)', () => {
  it('has the four write handlers and no others', () => expect(handlers.sort()).toEqual(['act', 'createManual', 'references', 'supplier']))
  it.each(['act', 'createManual', 'references', 'supplier'])('%s declares permissions, all of them real catalogue keys, and runs the booking access guard', (name) => {
    const keys = declared(name)
    expect(keys && keys.length).toBeGreaterThan(0)
    for (const key of keys!) expect(known.has(key)).toBe(true)
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[name] as object)).toEqual([BookingAccessGuard])
  })
  it('sits behind session authentication and tenant context at controller level', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BookingActionsController)).toEqual([SessionAuthGuard, TenantContextGuard])
  })
  it('the action route declares every permission any action can need, so no action is unreachable and none is opened to a stranger', () => {
    expect(new Set(declared('act'))).toEqual(new Set(['booking.confirm.manual', 'booking.on-request.resolve', 'booking.amend', 'booking.amend.request', 'booking.cancel', 'booking.cancel.request', 'booking.cancel.nonrefundable', 'booking.no-show.mark', 'booking.rebook']))
    expect(declared('references')).toEqual(['booking.supplier-ref.edit']); expect(declared('supplier')).toEqual(['booking.supplier.retry']); expect(declared('createManual')).toEqual(['booking.manual.create'])
  })
})
