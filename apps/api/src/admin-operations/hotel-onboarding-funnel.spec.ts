import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { OperationsController } from './operations.controller'
import { REQUIRED_SUPPLY_PERMISSION } from './supply-permission.guard'
import { BLOCKED_HOTELS_LIMIT, buildOnboardingFunnel, type FunnelHotel } from './hotel-onboarding-funnel'

const ALL = new Set(['supply.rooms.read', 'supply.mappings.read', 'supply.contracts.read', 'supply.rates.read', 'supply.availability.read'])
const full = { PUBLISHED: true, ROOMS_DEFINED: true, HOTEL_MAPPED: true, ROOMS_MAPPED: true, CONTRACT_ACTIVE: true, RATE_PLAN_ACTIVE: true, RATES_LOADED: true, INVENTORY_LOADED: true }
const hotel = (id: string, facts: FunnelHotel['facts']): FunnelHotel => ({ hotelId: id, hotelName: `Hotel ${id}`, city: 'Dubai', facts })
const now = new Date('2026-11-01T10:00:00.000Z')

describe('onboarding funnel', () => {
  it('counts cumulatively and names the first failing stage', () => {
    const report = buildOnboardingFunnel([
      hotel('a', full),
      hotel('b', { ...full, CONTRACT_ACTIVE: false }),
      // Rates loaded but no mapping: later passes must not count past the first failure.
      hotel('c', { ...full, HOTEL_MAPPED: false }),
      hotel('d', { PUBLISHED: false }),
    ], ALL, now, '2026-11-01')
    const reached = Object.fromEntries(report.stages.map(s => [s.stage, s.reached]))
    expect(reached).toMatchObject({ CREATED: 4, PUBLISHED: 3, ROOMS_DEFINED: 3, HOTEL_MAPPED: 2, ROOMS_MAPPED: 2, CONTRACT_ACTIVE: 1, INVENTORY_LOADED: 1 })
    expect(report.completeHotels).toBe(1)
    expect(Object.fromEntries(report.blockers.map(b => [b.stage, b.hotels]))).toMatchObject({ PUBLISHED: 1, HOTEL_MAPPED: 1, CONTRACT_ACTIVE: 1, RATES_LOADED: 0 })
    expect(report.blockedHotels.find(h => h.hotelId === 'b')).toMatchObject({ lastStageReached: 'ROOMS_MAPPED', blocker: 'CONTRACT_ACTIVE' })
    expect(report.blockedHotels.map(h => h.hotelId)).not.toContain('a')
  })

  it('reports unreadable stages and everything after them as null, never zero', () => {
    const held = new Set(['supply.rooms.read'])
    const report = buildOnboardingFunnel([hotel('a', full), hotel('b', { ...full, ROOMS_DEFINED: false })], held, now, '2026-11-01')
    const reached = Object.fromEntries(report.stages.map(s => [s.stage, s.reached]))
    expect(reached).toMatchObject({ CREATED: 2, PUBLISHED: 2, ROOMS_DEFINED: 1, HOTEL_MAPPED: null, INVENTORY_LOADED: null })
    expect(report.completeHotels).toBeNull()
    expect(report.blockers.find(b => b.stage === 'CONTRACT_ACTIVE')?.hotels).toBeNull()
    expect(report.blockedHotels.map(h => h.hotelId)).toEqual(['b'])
  })

  it('treats a missing fact as a failure and caps the blocked list', () => {
    const many = Array.from({ length: BLOCKED_HOTELS_LIMIT + 5 }, (_, i) => hotel(String(i).padStart(4, '0'), {}))
    const report = buildOnboardingFunnel(many, ALL, now, '2026-11-01')
    expect(report.blockedHotels).toHaveLength(BLOCKED_HOTELS_LIMIT)
    expect(report.blockedHotelsTruncated).toBe(true)
    expect(report.blockers.find(b => b.stage === 'PUBLISHED')?.hotels).toBe(many.length)
  })

  it('is empty-safe', () => {
    const report = buildOnboardingFunnel([], ALL, now, '2026-11-01')
    expect(report.totalHotels).toBe(0)
    expect(report.completeHotels).toBe(0)
    expect(report.stages.every(s => s.reached === 0)).toBe(true)
  })
})

describe('onboarding funnel authorization wiring', () => {
  it('requires authentication, tenant context and supply.hotels.read', () => {
    const handler = OperationsController.prototype.onboardingFunnel
    expect(Reflect.getMetadata(REQUIRED_SUPPLY_PERMISSION, handler)).toBe('supply.hotels.read')
    const own = (Reflect.getMetadata(GUARDS_METADATA, handler) as Array<{ name: string }>).map(g => g.name)
    const cls = (Reflect.getMetadata(GUARDS_METADATA, OperationsController) as Array<{ name: string }>).map(g => g.name)
    expect([...cls, ...own]).toEqual(['SessionAuthGuard', 'TenantContextGuard', 'SupplyPermissionGuard'])
  })
})
