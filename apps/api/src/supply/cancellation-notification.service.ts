import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { CancellationVoucherChannel, CancellationVoucherDeliveryRead } from '@bedbanks/contracts'

export interface DispatchVoucherCommand {
  tenantId: string
  userId: string
  requestId?: string
  bookingId: string
  bookingReference: string
  supplierCancellationRef: string | null
  channels: CancellationVoucherChannel[]
  currency: string
  penaltyMinor: bigint
  refundMinor: bigint
  idempotencyKey: string
}

@Injectable()
export class CancellationNotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async listDeliveries(tenantId: string, limit = 50): Promise<CancellationVoucherDeliveryRead[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 100)
    const events = await this.prisma.withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: {
          tenantId,
          action: 'notification.cancellation_voucher.dispatched',
          entityType: 'cancellation_voucher',
        },
        orderBy: { createdAt: 'desc' },
        take: bounded,
      }),
    )

    return events.map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      return {
        id: event.id,
        bookingId: String(payload.bookingId ?? event.entityId),
        bookingReference: String(payload.bookingReference ?? ''),
        channel: (payload.channel === 'SUPPLIER_WEBHOOK' ? 'SUPPLIER_WEBHOOK' : 'CLIENT_EMAIL') as CancellationVoucherChannel,
        status: (payload.deliveryStatus === 'QUEUED_FOR_RETRY' ? 'QUEUED_FOR_RETRY' : 'DISPATCHED') as 'DISPATCHED' | 'QUEUED_FOR_RETRY',
        supplierCancellationRef: typeof payload.supplierCancellationRef === 'string' ? payload.supplierCancellationRef : null,
        currency: String(payload.currency ?? 'AED'),
        penaltyMinor: String(payload.penaltyMinor ?? '0'),
        refundMinor: String(payload.refundMinor ?? '0'),
        idempotencyKey: String(payload.idempotencyKey ?? ''),
        dispatchedAt: event.createdAt.toISOString(),
      }
    })
  }

  async dispatch(command: DispatchVoucherCommand): Promise<CancellationVoucherDeliveryRead[]> {
    const idempotencyKey = command.idempotencyKey.trim()
    const bookingId = command.bookingId.trim()
    const bookingReference = command.bookingReference.trim()
    const currency = command.currency.trim().toUpperCase()
    if (!idempotencyKey || !bookingId || !bookingReference || !/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException('Invalid cancellation voucher dispatch payload')
    }
    if (command.penaltyMinor < 0n || command.refundMinor < 0n) {
      throw new BadRequestException('Voucher monetary amounts must be non-negative')
    }
    const validChannels: CancellationVoucherChannel[] = ['CLIENT_EMAIL', 'SUPPLIER_WEBHOOK']
    const channels = Array.from(new Set(command.channels))
    if (!channels.length || channels.some((ch) => !validChannels.includes(ch))) {
      throw new BadRequestException('At least one valid notification channel is required')
    }

    return this.prisma.withTenant(command.tenantId, async (tx) => {
      const existingEvents = await tx.auditEvent.findMany({
        where: {
          tenantId: command.tenantId,
          action: 'notification.cancellation_voucher.dispatched',
          entityType: 'cancellation_voucher',
          entityId: bookingId,
        },
        orderBy: { createdAt: 'asc' },
      })

      const matching = existingEvents.filter((event) => {
        const p = (event.payload ?? {}) as Record<string, unknown>
        return p.idempotencyKey === idempotencyKey
      })

      if (matching.length > 0) {
        const firstPayload = (matching[0].payload ?? {}) as Record<string, unknown>
        if (
          firstPayload.bookingReference !== bookingReference ||
          firstPayload.currency !== currency ||
          firstPayload.penaltyMinor !== command.penaltyMinor.toString() ||
          firstPayload.refundMinor !== command.refundMinor.toString()
        ) {
          throw new ConflictException('Voucher dispatch idempotency key was reused with different payload')
        }
        return matching.map((event) => {
          const p = (event.payload ?? {}) as Record<string, unknown>
          return {
            id: event.id,
            bookingId,
            bookingReference,
            channel: p.channel as CancellationVoucherChannel,
            status: (p.deliveryStatus as 'DISPATCHED' | 'QUEUED_FOR_RETRY') ?? 'DISPATCHED',
            supplierCancellationRef: typeof p.supplierCancellationRef === 'string' ? p.supplierCancellationRef : null,
            currency,
            penaltyMinor: String(p.penaltyMinor),
            refundMinor: String(p.refundMinor),
            idempotencyKey,
            dispatchedAt: event.createdAt.toISOString(),
          }
        })
      }

      const deliveries: CancellationVoucherDeliveryRead[] = []
      for (const channel of channels) {
        const event = await tx.auditEvent.create({
          data: {
            tenantId: command.tenantId,
            userId: command.userId,
            actorType: 'USER',
            action: 'notification.cancellation_voucher.dispatched',
            entityType: 'cancellation_voucher',
            entityId: bookingId,
            payload: {
              outcome: 'allowed',
              requestId: command.requestId ?? null,
              bookingId,
              bookingReference,
              channel,
              deliveryStatus: 'DISPATCHED',
              supplierCancellationRef: command.supplierCancellationRef ?? null,
              currency,
              penaltyMinor: command.penaltyMinor.toString(),
              refundMinor: command.refundMinor.toString(),
              idempotencyKey,
            },
          },
        })
        deliveries.push({
          id: event.id,
          bookingId,
          bookingReference,
          channel,
          status: 'DISPATCHED',
          supplierCancellationRef: command.supplierCancellationRef ?? null,
          currency,
          penaltyMinor: command.penaltyMinor.toString(),
          refundMinor: command.refundMinor.toString(),
          idempotencyKey,
          dispatchedAt: event.createdAt.toISOString(),
        })
      }
      return deliveries
    })
  }
}
