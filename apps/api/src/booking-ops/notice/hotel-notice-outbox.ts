import type { Prisma } from '@prisma/client'
import { normalizeCopyAddresses, resolveHotelNoticeRecipient } from './hotel-notice-recipient'

type FollowUpKind = 'AMEND' | 'CANCEL'

/**
 * Queues the NEW reservation notice for the hotel, inside the caller's confirmation transaction (ADR 0106). The recipient is read from the hotel profile now and
 * snapshotted on the row, so a later profile edit cannot redirect a notice already queued. With no usable reservations email the row is born FAILED
 * (NO_RESERVATIONS_EMAIL) and audited, so Operations sees the gap; the booking itself is never blocked by a hotel's missing mailbox. `copyTo` (the booking agent and the
 * admin mailbox) is snapshotted for blind copies. Writes no guest data and no message body. Returns what happened, for tests.
 */
export async function queueHotelNotice(tx: Prisma.TransactionClient, input: { tenantId: string; bookingId: string; hotelId: string; userId: string | null; requestId: string; now: Date; copyTo?: ReadonlyArray<string | null | undefined> }): Promise<'QUEUED' | 'NO_RESERVATIONS_EMAIL'> {
  const { tenantId, bookingId, hotelId, userId, requestId, now } = input
  const profile = await tx.hotelProfile.findFirst({ where: { tenantId, hotelId }, select: { contacts: true } })
  const recipient = resolveHotelNoticeRecipient(profile?.contacts)
  const copyAddresses = normalizeCopyAddresses(input.copyTo ?? [], recipient.ok ? recipient.address : null)
  await tx.hotelNotice.create({ data: recipient.ok
    ? { tenantId, bookingId, kind: 'NEW', toAddress: recipient.address, copyAddresses, runAfter: now, requestedByUserId: userId }
    : { tenantId, bookingId, kind: 'NEW', toAddress: null, copyAddresses, status: 'FAILED', lastErrorCode: recipient.code, runAfter: now, requestedByUserId: userId } })
  await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: recipient.ok ? 'booking.hotel_notice.queued' : 'booking.hotel_notice.failed', entityType: 'booking', entityId: bookingId,
    payload: { requestId, kind: 'NEW', copies: copyAddresses.length, ...(recipient.ok ? {} : { code: recipient.code }) } }] })
  return recipient.ok ? 'QUEUED' : recipient.code
}

/**
 * Queues an AMEND or CANCEL notice, in the transaction that changed the booking (ADR 0106). It tells only a hotel that WE told: the address and copies come from the
 * booking's NEW notice, so there is nothing to look up in the hotel profile (which the booking role cannot read), and a booking with no NEW notice (not sold from
 * contracted inventory, or confirmed before notices existed) queues nothing. If the NEW notice never had an address the follow-up is born FAILED the same way, so the gap stays
 * visible. Idempotent per (booking, kind, eventKey): a repeat queues nothing more. Returns what happened, for tests.
 */
export async function queueHotelNoticeFollowUp(tx: Prisma.TransactionClient, input: { tenantId: string; bookingId: string; kind: FollowUpKind; eventKey: string; userId: string | null; now: Date }): Promise<'QUEUED' | 'NO_RESERVATIONS_EMAIL' | 'NOT_APPLICABLE' | 'ALREADY_QUEUED'> {
  const { tenantId, bookingId, kind, eventKey, userId, now } = input
  const first = await tx.hotelNotice.findFirst({ where: { tenantId, bookingId, kind: 'NEW', eventKey: 'initial' }, select: { toAddress: true, copyAddresses: true } })
  if (!first) return 'NOT_APPLICABLE'
  const created = await tx.hotelNotice.createMany({ skipDuplicates: true, data: [first.toAddress
    ? { tenantId, bookingId, kind, eventKey, toAddress: first.toAddress, copyAddresses: first.copyAddresses, runAfter: now, requestedByUserId: userId }
    : { tenantId, bookingId, kind, eventKey, toAddress: null, copyAddresses: first.copyAddresses, status: 'FAILED', lastErrorCode: 'NO_RESERVATIONS_EMAIL', runAfter: now, requestedByUserId: userId }] })
  if (created.count !== 1) return 'ALREADY_QUEUED'
  await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: userId ? 'USER' : 'SYSTEM', action: first.toAddress ? 'booking.hotel_notice.queued' : 'booking.hotel_notice.failed', entityType: 'booking', entityId: bookingId,
    payload: { kind, copies: first.copyAddresses.length, ...(first.toAddress ? {} : { code: 'NO_RESERVATIONS_EMAIL' }) } }] })
  return first.toAddress ? 'QUEUED' : 'NO_RESERVATIONS_EMAIL'
}
