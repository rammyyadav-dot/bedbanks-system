import type { Prisma } from '@prisma/client'
import { UnprocessableEntityException } from '@nestjs/common'

/** Serialize publication and edits which affect the reviewed Hotel Master. */
export async function lockHotelSetup(tx: Prisma.TransactionClient, tenantId: string, hotelId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hotel-setup:${tenantId}:${hotelId}`}, 0))`
}

/** Called under the hotel lock by both canonical and legacy room authoring. */
export async function assertRoomActivationAllowed(tx: Prisma.TransactionClient, hotel: { id: string; contentStatus: string }, roomId: string, active: boolean): Promise<void> {
  if (!active && hotel.contentStatus === 'COMPLETE' && await tx.roomType.count({ where: { hotelId: hotel.id, isActive: true, id: { not: roomId } } }) === 0) {
    throw new UnprocessableEntityException({ message: 'A published hotel needs at least one active room. Change the hotel status first.', code: 'HOTEL_PUBLICATION_REQUIREMENT_LOST' })
  }
}

/** The token a Hotel Setup form carries: the profile version (0 before the first save) plus the hotel's `updatedAt`. */
export const setupToken = (hotel: { updatedAt: Date }, profile: { version: number } | null): string => `${profile?.version ?? 0}.${hotel.updatedAt.getTime()}`

/**
 * Records that something on the hotel changed outside the profile form (for example its amenities): bumps the hotel's `updatedAt`
 * and the profile version, creating the profile row if the hotel has none, so every open Setup form becomes stale.
 */
export async function touchSetup(tx: Prisma.TransactionClient, tenantId: string, hotelId: string, userId: string, now: Date): Promise<void> {
  await tx.hotel.update({ where: { id: hotelId }, data: { updatedAt: now } })
  const profile = await tx.hotelProfile.findFirst({ where: { hotelId, tenantId }, select: { id: true } })
  if (profile) await tx.hotelProfile.update({ where: { id: profile.id }, data: { updatedById: userId, version: { increment: 1 } } })
  else await tx.hotelProfile.create({ data: { tenantId, hotelId, updatedById: userId, version: 1 } })
}
