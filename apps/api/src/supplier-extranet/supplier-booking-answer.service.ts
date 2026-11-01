import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { ExtranetBookingAnswerResult, ExtranetBookingStatus } from '@bedbanks/contracts'
import { BookingOpsDatabase } from '../booking-ops/booking-ops-database'
import { transitionBooking } from '../booking-ops/booking-transition'
import { SupplierExtranetService } from './supplier-extranet.service'
import { ANSWER_REQUIRES_SETTLEMENT, ANSWER_REQUIRES_SETTLEMENT_MESSAGE, missingAnswerFields, supplierAnswerAction } from './supplier-booking-answer'
import type { AnswerBookingDto } from './answer-booking.dto'

const PERMISSION = 'supplier.extranet.bookings.answer'
const KEY = /^[A-Za-z0-9._:-]{8,128}$/

/**
 * A supplier answers one of its own bookings (ADR 0061 Amendment 2, option A: confirm, on request, reject).
 *
 * Scope is the authenticated tenant plus the organization resolved by SupplierOrganizationGuard; a booking owned by anyone else is "not found", never "forbidden".
 * The write runs on the booking-module role through `transitionBooking`, the one writer of Booking.status (ADR 0039), so lifecycle rules, compare-and-set,
 * idempotency and the finance event are exactly those of the operator path. The API runtime role gains no booking write. No supplier is contacted and no guest
 * data is read or logged.
 */
@Injectable()
export class SupplierBookingAnswerService {
  constructor(private readonly db: BookingOpsDatabase, private readonly extranet: SupplierExtranetService) {}

  async answer(tenantId: string, userId: string, supplierId: string, bookingId: string, body: AnswerBookingDto, rawKey: unknown, requestId: string | undefined, now = new Date()): Promise<ExtranetBookingAnswerResult> {
    await this.extranet.requirePermission(tenantId, userId, PERMISSION)
    if (typeof rawKey !== 'string' || !KEY.test(rawKey)) throw new BadRequestException({ message: 'An Idempotency-Key header of 8 to 128 letters, digits or . _ : - is required', code: 'IDEMPOTENCY_KEY_REQUIRED' })
    const missing = missingAnswerFields(body.answer, body)
    if (missing.length > 0) throw new UnprocessableEntityException({ message: `Required: ${missing.join(', ')}`, code: 'MISSING_FIELDS', fields: missing })

    return this.db.withTenantWrite(tenantId, async (tx) => {
      // Serialises this answer against operator actions and supplier jobs on the same booking.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} AND "supplier_id" = ${supplierId} FOR UPDATE`
      if (locked.length !== 1) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })

      // A replay (same key, same body) returns the stored outcome whatever the booking has become since; the lifecycle check below applies to first calls only.
      const current = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId, supplierId }, select: { status: true } })
      const plan = supplierAnswerAction(body.answer, body.expectedStatus)
      const earlier = await tx.bookingEvent.findUnique({ where: { tenantId_bookingId_idempotencyKey: { tenantId, bookingId, idempotencyKey: rawKey } }, select: { id: true } })
      if (!plan && !earlier) throw new BadRequestException({ message: 'That answer is not available for this booking', code: 'ANSWER_NOT_AVAILABLE', currentStatus: current.status })
      // ADR 0061 Amendment 4: a first answer is refused until the platform can settle the booking's wallet reservation and inventory hold in the same step.
      if (!earlier) throw new ConflictException({ message: ANSWER_REQUIRES_SETTLEMENT_MESSAGE, code: ANSWER_REQUIRES_SETTLEMENT, currentStatus: current.status })
      const action = plan ?? { action: 'systemConfirm' as const, supplierStatus: '' }

      const outcome = await transitionBooking(tx, {
        tenantId, bookingId, action: action.action, expectedStatus: body.expectedStatus as ExtranetBookingStatus,
        actor: { type: 'USER', id: userId }, level: 'SYSTEM', reason: body.reason, supplierRef: body.supplierRef, hotelConfirmationNo: body.hotelConfirmationNo,
        supplierStatus: action.supplierStatus, emitFinance: true, idempotencyKey: rawKey, now,
        // Facts only, never free text or guest data. Separates this from an operator's answer in the immutable event.
        eventPayload: { via: 'supplier_extranet', supplierId, answer: body.answer },
      })
      if (!outcome.replayed) {
        // createMany, not create: the booking role may INSERT audit events but never read them, and `create` returns the row.
        await tx.auditEvent.createMany({
          data: [{
            tenantId, userId, actorType: 'USER', action: 'supplier.booking.answered', entityType: 'booking', entityId: bookingId,
            payload: { outcome: 'allowed', answer: body.answer, from: body.expectedStatus, to: outcome.status, supplierId, requestId: requestId ?? null } as Prisma.InputJsonValue,
          }],
        })
      }
      return { bookingId: outcome.bookingId, reference: outcome.reference, status: outcome.status as ExtranetBookingStatus, replayed: outcome.replayed }
    })
  }
}
