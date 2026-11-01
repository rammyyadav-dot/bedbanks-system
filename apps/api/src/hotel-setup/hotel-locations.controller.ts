import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common'
import type { HotelLocationOptions } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { PrismaService } from '../database/prisma.service'
import { guardedRead } from '../admin-operations/operations-read'

@Controller('admin/hotels/location-options')
@UseGuards(SessionAuthGuard, TenantContextGuard, SupplyPermissionGuard)
export class HotelLocationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get() @RequireSupplyPermission('supply.hotels.read')
  async get(@ActiveTenant() tenantId: string, @Query('countryCode') raw?: unknown): Promise<HotelLocationOptions> {
    if (raw !== undefined && typeof raw !== 'string') throw new BadRequestException('countryCode must be one ISO-2 value')
    const countryCode = (raw as string | undefined)?.trim().toUpperCase() || null
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) throw new BadRequestException('countryCode must be ISO-2')
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const countries = await tx.hotel.findMany({ where: { tenantId }, distinct: ['countryCode'], select: { countryCode: true }, orderBy: { countryCode: 'asc' }, take: 251 })
      const cities = countryCode ? await tx.hotel.findMany({ where: { tenantId, countryCode }, distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' }, take: 201 }) : []
      return { countries: countries.slice(0, 250).map(c => c.countryCode), cities: cities.slice(0, 200).map(c => c.city), countryCode, capped: countries.length > 250 || cities.length > 200 }
    }))
  }
}
