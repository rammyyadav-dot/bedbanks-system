import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { operationsPermissions } from '@bedbanks/contracts'
import { AgentRbacGuard, REQUIRED_PERMISSION } from '../agent/rbac.guard'
import { OperationsController } from './operations.controller'

const proto = OperationsController.prototype as unknown as Record<string, unknown>
const handlers = Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor' && typeof proto[name] === 'function')
const allowed = new Set<string>(Object.values(operationsPermissions))

describe('OperationsController authorization wiring', () => {
  it('has handlers', () => expect(handlers.length).toBeGreaterThan(10))

  it.each(handlers.filter(h => h !== 'capabilities'))('%s declares a permission and runs the RBAC guard (fail closed)', name => {
    const fn = proto[name] as object
    const permission = Reflect.getMetadata(REQUIRED_PERMISSION, fn) as string | undefined
    expect(permission && allowed.has(permission)).toBe(true)
    expect(Reflect.getMetadata(GUARDS_METADATA, fn)).toContain(AgentRbacGuard)
  })

  it('every handler sits behind session authentication and tenant context at controller level', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, OperationsController) as Array<{ name: string }>).map(g => g.name)
    expect(guards).toEqual(['SessionAuthGuard', 'TenantContextGuard'])
  })

  it('mutates through exactly one handler, which requires booking.reconcile', () => {
    const posts = handlers.filter(h => Reflect.getMetadata('method', proto[h] as object) === 1) // RequestMethod.POST
    expect(posts).toEqual(['reconcile'])
    expect(Reflect.getMetadata(REQUIRED_PERMISSION, proto.reconcile as object)).toBe('booking.reconcile')
  })
})
