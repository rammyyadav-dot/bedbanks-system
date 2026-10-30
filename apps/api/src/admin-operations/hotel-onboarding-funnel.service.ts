import { Injectable } from '@nestjs/common'
import type { OnboardingFunnelReport } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { buildOnboardingFunnel, type FunnelHotel } from './hotel-onboarding-funnel'

/**
 * Read-only onboarding funnel. Tenant comes from the session; the controller requires supply.hotels.read, and each later
 * stage is only evaluated when the caller also holds that domain's read permission (otherwise it is reported as unknown).
 * Every query runs in one tenant-scoped transaction and filters tenantId explicitly as well as through RLS.
 */
@Injectable()
export class HotelOnboardingFunnelService {
  constructor(private readonly prisma: PrismaService) {}

  async report(tenantId: string, userId: string, now = new Date()): Promise<OnboardingFunnelReport> {
    const asOfDate = now.toISOString().slice(0, 10)
    const today = new Date(`${asOfDate}T00:00:00.000Z`)
    const hotels = await this.prisma.withTenant(tenantId, async (tx) => {
      const roles = await tx.userRole.findMany({ where: { userId, tenantId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } })
      const held = new Set(roles.flatMap(a => a.role.permissions.map(p => p.permission.key)))
      const rows = await tx.hotel.findMany({ where: { tenantId }, select: { id: true, name: true, city: true, contentStatus: true }, orderBy: { id: 'asc' } })

      const roomHotels = new Set((await tx.roomType.groupBy({ by: ['hotelId'], where: { isActive: true, hotel: { tenantId } } })).map(r => r.hotelId))
      const mappedHotels = new Set((await tx.supplierHotelMapping.groupBy({ by: ['hotelId'], where: { tenantId, status: 'MAPPED' } })).map(r => r.hotelId))
      const roomMappedHotels = new Set((await tx.supplierRoomMapping.groupBy({ by: ['hotelId'], where: { tenantId, status: 'MAPPED', supplierHotelMapping: { status: 'MAPPED' } } })).map(r => r.hotelId))
      const contracts = await tx.contract.findMany({ where: { tenantId, status: 'ACTIVE', validTo: { gte: today }, supplierHotelMapping: { status: 'MAPPED' } }, select: { supplierHotelMapping: { select: { hotelId: true } } } })
      const contractHotels = new Set(contracts.flatMap(c => (c.supplierHotelMapping ? [c.supplierHotelMapping.hotelId] : [])))
      const plans = await tx.ratePlan.findMany({
        where: { tenantId, status: 'ACTIVE', contract: { status: 'ACTIVE', validTo: { gte: today } }, roomType: { isActive: true }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
        select: { id: true, inventoryPoolId: true, roomType: { select: { hotelId: true } } },
      })
      const planHotel = new Map(plans.map(p => [p.id, p.roomType.hotelId]))
      const planIds = plans.map(p => p.id)
      const planHotels = new Set(planHotel.values())

      // Rates must carry an explicit SELL/NET basis: a NULL basis is unverified and the evaluator rejects it.
      const rated = planIds.length
        ? await tx.dailyRate.groupBy({ by: ['ratePlanId'], where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte: today }, amountBasis: { not: null } } })
        : []
      const rateHotels = new Set(rated.flatMap(r => (planHotel.has(r.ratePlanId) ? [planHotel.get(r.ratePlanId)!] : [])))

      // Open stock: a plan's own open night, or (for a pooled plan) an open night in its pool. FREE_SALE needs no counters.
      const unpooled = plans.filter(p => !p.inventoryPoolId).map(p => p.id)
      const open = unpooled.length
        ? await tx.$queryRaw<Array<{ rate_plan_id: string }>>`
            SELECT DISTINCT rate_plan_id FROM "DailyAvailability"
            WHERE tenant_id = ${tenantId} AND rate_plan_id = ANY(${unpooled}::text[]) AND stay_date >= ${today}::date AND NOT stop_sell
              AND (inventory_mode = 'FREE_SALE' OR (inventory_mode = 'ALLOTMENT' AND allotment - sold - held > 0))`
        : []
      const stockHotels = new Set(open.flatMap(r => (planHotel.has(r.rate_plan_id) ? [planHotel.get(r.rate_plan_id)!] : [])))
      const pooledPlans = plans.filter(p => p.inventoryPoolId)
      if (pooledPlans.length) {
        const poolIds = [...new Set(pooledPlans.map(p => p.inventoryPoolId!))]
        const openPools = new Set((await tx.$queryRaw<Array<{ pool_id: string }>>`
            SELECT DISTINCT d.pool_id FROM "InventoryPoolDay" d JOIN "InventoryPool" p ON p.id = d.pool_id AND p.tenant_id = d.tenant_id
            WHERE d.tenant_id = ${tenantId} AND d.pool_id = ANY(${poolIds}::text[]) AND p.status = 'ACTIVE' AND d.stay_date >= ${today}::date
              AND d.capacity - d.sold - d.held > 0`).map(r => r.pool_id))
        for (const plan of pooledPlans) if (openPools.has(plan.inventoryPoolId!)) stockHotels.add(plan.roomType.hotelId)
      }

      const out: FunnelHotel[] = rows.map(h => ({
        hotelId: h.id, hotelName: h.name, city: h.city,
        facts: {
          PUBLISHED: h.contentStatus === 'COMPLETE', ROOMS_DEFINED: roomHotels.has(h.id), HOTEL_MAPPED: mappedHotels.has(h.id), ROOMS_MAPPED: roomMappedHotels.has(h.id),
          CONTRACT_ACTIVE: contractHotels.has(h.id), RATE_PLAN_ACTIVE: planHotels.has(h.id), RATES_LOADED: rateHotels.has(h.id), INVENTORY_LOADED: stockHotels.has(h.id),
        },
      }))
      return { out, held }
    })
    return buildOnboardingFunnel(hotels.out, hotels.held, now, asOfDate)
  }
}
