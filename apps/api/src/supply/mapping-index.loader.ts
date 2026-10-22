import type { Prisma } from '@prisma/client'
import { buildMappingIndex, type MappingIndex } from '../mapping/observation-resolution'

/**
 * Loads one supplier's hotel, room and rate plan mappings for resolution (ADR 0081). Every query names the tenant; the caller supplies a tenant-scoped transaction. Rows of every status are
 * loaded, because "pending" and "rejected" are different answers from "unmapped" and the review feed needs to tell them apart.
 */
export async function loadMappingIndex(tx: Prisma.TransactionClient, tenantId: string, supplierId: string): Promise<MappingIndex> {
  const hotels = await tx.supplierHotelMapping.findMany({ where: { tenantId, supplierId }, select: { id: true, supplierHotelId: true, hotelId: true, status: true } })
  const hotelIds = hotels.map((h) => h.id)
  const rooms = hotelIds.length === 0 ? [] : await tx.supplierRoomMapping.findMany({ where: { tenantId, supplierHotelMappingId: { in: hotelIds } }, select: { id: true, supplierHotelMappingId: true, supplierRoomId: true, roomTypeId: true, status: true } })
  const roomIds = rooms.map((r) => r.id)
  const plans = roomIds.length === 0 ? [] : await tx.supplierRatePlanMapping.findMany({ where: { tenantId, supplierRoomMappingId: { in: roomIds } }, select: { id: true, supplierRoomMappingId: true, supplierRatePlanCode: true, ratePlanId: true, status: true, ratePlan: { select: { currency: true } } } })
  return buildMappingIndex(hotels, rooms, plans.map((p) => ({ id: p.id, supplierRoomMappingId: p.supplierRoomMappingId, supplierRatePlanCode: p.supplierRatePlanCode, ratePlanId: p.ratePlanId, ratePlanCurrency: p.ratePlan.currency, status: p.status })))
}
