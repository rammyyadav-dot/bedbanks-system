import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { supplyPermissions } from '@bedbanks/contracts'
import { REQUIRED_SUPPLY_PERMISSION, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { CommercialController } from './commercial.controller'

const proto = CommercialController.prototype as unknown as Record<string, unknown>
const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
const method = (n: string) => Reflect.getMetadata('method', proto[n] as object) as number // 0 GET, 1 POST
const needs = (n: string) => Reflect.getMetadata(REQUIRED_SUPPLY_PERMISSION, proto[n] as object) as string | undefined
const guards = (n: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[n] as object) ?? []) as unknown[]

describe('CommercialController authorization wiring (ADR 0018)', () => {
  it('has the markup handlers', () => expect(handlers.sort()).toEqual(['approve', 'cancel', 'create', 'execute', 'list', 'reject', 'requestActivation', 'retire']))

  it.each(handlers)('%s declares an existing supply.* permission and runs the fail-closed guard', (name) => {
    expect(Object.values(supplyPermissions) as string[]).toContain(needs(name))
    expect(guards(name)).toContain(SupplyPermissionGuard)
  })

  it('reads need supply.rates.read; every change needs supply.rates.manage', () => {
    for (const n of handlers) expect(needs(n)).toBe(method(n) === 0 ? 'supply.rates.read' : 'supply.rates.manage')
  })

  it('every handler sits behind session authentication and tenant context at controller level', () => {
    const names = (Reflect.getMetadata(GUARDS_METADATA, CommercialController) as Array<{ name: string }>).map((g) => g.name)
    expect(names).toEqual(['SessionAuthGuard', 'TenantContextGuard'])
  })

  it('exposes no update or delete: rules are immutable, only their status moves', () => {
    for (const n of handlers) expect([0, 1]).toContain(method(n)) // GET or POST only
    expect(handlers).not.toContain('update'); expect(handlers).not.toContain('remove')
  })
})
