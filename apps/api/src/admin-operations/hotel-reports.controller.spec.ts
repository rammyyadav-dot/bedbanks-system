import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { HotelReportsController } from './hotel-reports.controller'
import { REQUIRED_SUPPLY_PERMISSION } from './supply-permission.guard'
describe('hotel reports authorization wiring', () => {
  it('requires authentication, tenant, hotel read permission and scoped booking access for reads/exports', () => {
    expect(Reflect.getMetadata(REQUIRED_SUPPLY_PERMISSION, HotelReportsController)).toBe('supply.hotels.read')
    const guards = Reflect.getMetadata(GUARDS_METADATA, HotelReportsController) as Array<{ name: string }>
    expect(guards.map(g => g.name)).toEqual(['SessionAuthGuard', 'TenantContextGuard', 'SupplyPermissionGuard', 'BookingAccessGuard'])
  })
})
