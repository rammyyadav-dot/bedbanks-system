import type { Prisma } from '@prisma/client'
import { resolveHotelNoticeRecipient } from './hotel-notice-recipient'

/**
 * Queues the NEW reservation notice for the hotel, inside the caller's confirmation transaction (ADR 0106). The recipient is read from the hotel profile now and
 * snapshotted on the row, so a later profile edit cannot redirect a notice already queued. With no usable reservations email the row is born FAILED
 * (NO_RESERVATIONS_EMAIL) and audited, so Operations sees the gap; the booking itself is never blocked by a hotel's missing mailbox. Returns what happened, for the audit
 * payload and tests. Writes no guest data and no message body.
 */
export async function queueHotelNotice(tx: Prisma.TransactionClient, input: { tenantId: string; bookingId: string; hotelId: string; userId: string | null; requestId: string; now: Date }): Promise<'QUEUED' | 'NO_RESERVATIONS_EMAIL'> {
  const { tenantId, bookingId, hotelId, userId, requestId, now } = input
  const profile = await tx.hotelProfile.findFirst({ where: { tenantId, hotelId }, select: { contacts: true } })
  const recipient = resolveHotelNoticeRecipient(profile?.contacts)
  await tx.hotelNotice.create({ data: recipient.ok
    ? { tenantId, bookingId, kind: 'NEW', toAddress: recipient.address, runAfter: now, requestedByUserId: userId }
    : { tenantId, bookingId, kind: 'NEW', toAddress: null, status: 'FAILED', lastErrorCode: recipient.code, runAfter: now, requestedByUserId: userId } })
  await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: recipient.ok ? 'booking.hotel_notice.queued' : 'booking.hotel_notice.failed', entityType: 'booking', entityId: bookingId,
    payload: { requestId, kind: 'NEW', ...(recipient.ok ? {} : { code: recipient.code }) } } })
  return recipient.ok ? 'QUEUED' : recipient.code
}
