import { derivedParentSelect } from './derived-rates'

/**
 * The one select that loads a rate plan with everything the shared stay evaluator needs over a window of nights (ADR 0067, F-07): Admin hotel
 * operations, rate certification and the Sellability Inspector load plans through it, so none can forget a rule the Agent applies.
 * `lte` is the last night; the availability row of the day after carries closedToDeparture for a stay ending on it.
 */
export const assessPlanSelect = (tenantId: string, { gte, lte }: { gte: Date; lte: Date }) => {
  const lteDeparture = new Date(lte.getTime() + 86_400_000)
  return {
    id: true, code: true, status: true, occupancy: true, currency: true, minStay: true, maxStay: true, releaseDays: true, releaseTimeLocal: true, validFrom: true, validTo: true, cancellationPolicySet: true, salesMarkets: true, nationalities: true, guestPrices: { select: { kind: true, minAge: true, maxAge: true, amountMinor: true, amountBasis: true, currency: true } }, promotions: { select: { id: true, kind: true, name: true, percentBp: true, minLeadDays: true, maxLeadDays: true, minNights: true, freeNights: true, bookFrom: true, bookTo: true, stayFrom: true, stayTo: true, combinable: true, stayWindowMode: true, discountBase: true } }, inventoryPoolId: true, refundable: true, contractId: true, roomTypeId: true, boardBasisId: true,
    boardBasis: { select: { code: true, isActive: true } },
    roomType: { select: { id: true, name: true, code: true, hotelId: true, isActive: true, maxAdults: true, maxChildren: true, maxOccupancy: true, hotel: { select: { contentStatus: true, timeZone: true } } } },
    contract: { select: { cancellationPolicies: { select: { policySet: true } }, leadTimeRules: { select: { minLeadHours: true, maxLeadDays: true } }, minStayMode: true, supplements: { select: { kind: true, name: true, boardBasisId: true, ratePlanId: true, basis: true, frequency: true, amountMinor: true, currency: true, stayFrom: true, stayTo: true } },
      // ADR 0089: only approved, active, eligible event supplements are ever loaded for pricing — never a draft, pending, suspended or expired rule, and never one of an unapproved event.
      eventSupplements: { where: { status: 'ACTIVE', roomEvent: { status: 'APPROVED' }, validFrom: { lte }, validTo: { gte } }, select: { id: true, roomEventId: true, roomEvent: { select: { name: true } }, ratePlanId: true, amountKind: true, basis: true, frequency: true, amountMinor: true, percentBp: true, currency: true, validFrom: true, validTo: true, stackable: true, priority: true } },
      childPolicies: { select: { minAge: true, maxAge: true, supplementMinor: true, currency: true } }, id: true, code: true, status: true, validFrom: true, validTo: true, settlementCurrency: true, salesMarkets: true, nationalities: true, supplierId: true, supplierHotelMappingId: true, supplier: { select: { status: true, displayName: true } } } },
    dailyRates: { where: { tenantId, stayDate: { gte, lte } }, select: { stayDate: true, amountMinor: true, currency: true, amountBasis: true, occupancy: true } },
    // ADR 0058, S10b: a derived plan is priced from its parent's rates in the same window.
    derivedFromId: true, derivedMode: true, derivedAdjustment: true,
    derivedFrom: { select: derivedParentSelect({ tenantId, stayDate: { gte, lte } }) },
    // One day past the window: the departure row of the last night carries closedToDeparture.
    availability: { where: { tenantId, stayDate: { gte, lte: lteDeparture } }, select: { stayDate: true, allotment: true, sold: true, held: true, stopSell: true, minStay: true, closedToArrival: true, closedToDeparture: true, releaseDays: true, inventoryMode: true, source: true, freshUntil: true } },
    inventoryPool: { select: { name: true, days: { where: { tenantId, stayDate: { gte, lte } }, select: { stayDate: true, capacity: true, sold: true, held: true, source: true, freshUntil: true } } } },
  } as const
}
