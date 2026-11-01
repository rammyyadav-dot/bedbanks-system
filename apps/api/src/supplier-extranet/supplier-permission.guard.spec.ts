import { ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common'
import { METHOD_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { REQUEST_USER_KEY } from '../auth/auth.constants'
import { ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import { SupplierChangeSetsController } from './supplier-change-sets.controller'
import { SupplierExtranetController } from './supplier-extranet.controller'
import { SUPPLIER_PERMISSION_KEY, SUPPLIER_SELF, SupplierPermissionGuard } from './supplier-permission.guard'
import type { SupplierExtranetService } from './supplier-extranet.service'

const request = { [REQUEST_USER_KEY]: { user: { id: 'user-a' } }, [ACTIVE_TENANT_REQUEST_KEY]: 'tenant-a', headers: {} }
const contextFor = (handler: unknown): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => class {} }) as unknown as ExecutionContext

describe('SupplierPermissionGuard', () => {
  const requirePermission = jest.fn()
  const guard = new SupplierPermissionGuard(new Reflector(), { requirePermission } as unknown as SupplierExtranetService)
  const reflected = (permission?: string) => { const h = () => undefined; if (permission) Reflect.defineMetadata(SUPPLIER_PERMISSION_KEY, permission, h); return h }
  beforeEach(() => requirePermission.mockReset())

  it('fails closed when a route declares no permission', async () => {
    await expect(guard.canActivate(contextFor(reflected()))).rejects.toBeInstanceOf(ForbiddenException)
    expect(requirePermission).not.toHaveBeenCalled()
  })

  it('lets SELF routes through without a permission lookup', async () => {
    await expect(guard.canActivate(contextFor(reflected(SUPPLIER_SELF)))).resolves.toBe(true)
    expect(requirePermission).not.toHaveBeenCalled()
  })

  it('verifies the declared permission for the active tenant and caller', async () => {
    requirePermission.mockResolvedValue(undefined)
    await expect(guard.canActivate(contextFor(reflected('supplier.extranet.hotels.read')))).resolves.toBe(true)
    expect(requirePermission).toHaveBeenCalledWith('tenant-a', 'user-a', 'supplier.extranet.hotels.read')
  })

  it('refuses a caller who lacks the declared permission', async () => {
    requirePermission.mockRejectedValue(new ForbiddenException('Access denied'))
    await expect(guard.canActivate(contextFor(reflected('supplier.extranet.bookings.answer')))).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe('every supplier extranet route declares its permission', () => {
  for (const controller of [SupplierExtranetController, SupplierChangeSetsController]) {
    const routes = Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, controller.prototype[name as keyof typeof controller.prototype]) !== undefined)
    it(`${controller.name} has routes`, () => expect(routes.length).toBeGreaterThan(0))
    for (const name of routes) {
      const handler = controller.prototype[name as keyof typeof controller.prototype]
      const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]
      it(`${controller.name}.${name} (${verb})`, () => {
        expect(Reflect.getMetadata(SUPPLIER_PERMISSION_KEY, handler)).toEqual(expect.stringMatching(/^(SELF|supplier\.extranet\.[a-z.]+)$/))
      })
    }
  }
})
