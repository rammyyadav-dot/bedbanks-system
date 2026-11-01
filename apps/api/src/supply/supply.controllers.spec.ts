import 'reflect-metadata'
import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { supplyPermissions } from '@bedbanks/contracts'
import { REQUIRED_SUPPLY_PERMISSION, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import type { PrismaService } from '../database/prisma.service'
import { MappingController } from './mapping.controller'
import { RatePlanApprovalController } from './rate-plan-approval.controller'
import { SupplyController } from './supply.controller'

/**
 * Supply, mapping and rate-plan approval handlers declare their permission at the controller (CLAUDE.md invariant 2), so a caller
 * without it is refused before any validation or lookup. The services keep their own check of the same key as defence in depth.
 */
const known = Object.values(supplyPermissions) as string[]
const handlersOf = (c: { prototype: object }) => {
  const proto = c.prototype as Record<string, unknown>
  return Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function' && Reflect.getMetadata('path', proto[n] as object) !== undefined)
    .map((n) => ({ name: n, fn: proto[n] as object }))
}
const needs = (fn: object) => Reflect.getMetadata(REQUIRED_SUPPLY_PERMISSION, fn) as string | string[] | undefined
const guards = (fn: object) => (Reflect.getMetadata(GUARDS_METADATA, fn) ?? []) as unknown[]

describe('Supply controllers authorization wiring', () => {
  it.each([SupplyController, MappingController, RatePlanApprovalController].flatMap((c) => handlersOf(c).filter((h) => !(c === SupplyController && h.name === 'capabilities')).map((h) => [`${c.name}.${h.name}`, h.fn] as const)))(
    '%s declares an existing supply.* permission and runs the fail-closed guard', (_name, fn) => {
      const declared = needs(fn)
      expect(declared).toBeDefined()
      for (const key of ([] as string[]).concat(declared!)) expect(known).toContain(key)
      expect(guards(fn)).toContain(SupplyPermissionGuard)
    })

  it('the capability list is the only supply handler without a permission: it answers with the caller\'s own keys', () => {
    expect(needs((SupplyController.prototype as unknown as Record<string, object>).capabilities)).toBeUndefined()
  })

  it('reads need a read key and changes a manage key; a calendar edit admits either manage key and the service enforces the exact one', () => {
    for (const c of [SupplyController, MappingController, RatePlanApprovalController]) {
      for (const h of handlersOf(c)) {
        const declared = needs(h.fn)
        if (declared === undefined) continue
        const keys = ([] as string[]).concat(declared)
        const read = Reflect.getMetadata('method', h.fn) === 0 || ['previewCalendarImport', 'sellability'].includes(h.name)
        for (const key of keys) expect(`${c.name}.${h.name}:${key.endsWith(read ? '.read' : '.manage')}`).toBe(`${c.name}.${h.name}:true`)
      }
    }
    const proto = SupplyController.prototype as unknown as Record<string, object>
    expect(needs(proto.applyCalendar)).toEqual(['supply.rates.manage', 'supply.availability.manage'])
    expect(needs(proto.bulkAvailability)).toBe('supply.availability.manage')
  })
})

describe('SupplyPermissionGuard', () => {
  const findMany = jest.fn()
  const auditCreate = jest.fn().mockResolvedValue(undefined)
  const withTenant = jest.fn(async (_t: string, work: (tx: unknown) => Promise<unknown>) => work({ userRole: { findMany }, auditEvent: { create: auditCreate } }))
  const reflected = jest.fn()
  const guard = new SupplyPermissionGuard({ getAllAndOverride: reflected } as unknown as Reflector, { withTenant } as unknown as PrismaService)
  const context = () => ({
    switchToHttp: () => ({ getRequest: () => ({ user: { user: { id: 'u' }, memberships: [{ tenantId: 't', tenantName: 'T', role: 'member' }] }, [ACTIVE_TENANT_REQUEST_KEY]: 't' }) }),
    getHandler: () => undefined, getClass: () => undefined,
  }) as unknown as ExecutionContext
  const holds = (...keys: string[]) => findMany.mockResolvedValue([{ role: { permissions: keys.map((key) => ({ permission: { key } })) } }])

  beforeEach(() => jest.clearAllMocks())

  it('fails closed without a declaration', async () => {
    reflected.mockReturnValue(undefined)
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException)
    reflected.mockReturnValue([])
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('admits any one of several declared keys and audits a denial naming them all', async () => {
    reflected.mockReturnValue(['supply.rates.manage', 'supply.availability.manage'])
    holds('supply.availability.manage')
    await expect(guard.canActivate(context())).resolves.toBe(true)
    holds('supply.rates.read')
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException)
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'permission.denied', entityId: 'supply.rates.manage|supply.availability.manage' }) }))
  })
})
