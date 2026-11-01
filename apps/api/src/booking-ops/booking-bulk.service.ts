import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  BOOKING_BULK_FAILURE, BOOKING_BULK_PERMISSION, finalBulkStatus, validateBulkRequest,
  type BookingAccessView, type BookingBulkItemError, type BookingBulkOperationView, type BookingBulkRequest,
} from '@bedbanks/contracts'
import { BookingOpsDatabase } from './booking-ops-database'
import { BookingOpsService } from './booking-ops.service'

/** A claim on a PROCESSING operation older than this is taken over: its worker is presumed gone. Items already applied are recognised by their inner event, never re-applied. */
const STALE_CLAIM_MS = 120_000

/** Stable reason code for an item from whatever the single-booking service threw. Never an exception message; anything unrecognised is INTERNAL_ERROR. */
export function mapBulkItemError(error: unknown): BookingBulkItemError {
  if (!(error instanceof HttpException)) return 'INTERNAL_ERROR'
  const body = error.getResponse() as { code?: unknown } | string
  const code = typeof body === 'object' && body !== null ? body.code : undefined
  if (error instanceof NotFoundException) return 'NOT_FOUND'
  if (error instanceof ForbiddenException) return code === 'BOOKING_OPS_CROSS_TENANT_DENIED' || code === 'BOOKING_OPS_INELIGIBLE_ASSIGNEE' ? 'ASSIGNEE_NOT_ALLOWED' : 'FORBIDDEN'
  if (error instanceof ConflictException) return code === 'BOOKING_OPS_CONFLICT' ? 'STALE_STATE' : code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'INVALID_STATE'
  return 'INTERNAL_ERROR'
}

export const bulkFingerprint = (req: Pick<BookingBulkRequest, 'action' | 'payload' | 'bookingIds'>): string =>
  createHash('sha256').update(JSON.stringify([req.action, req.payload, [...req.bookingIds].sort()])).digest('hex')

/** The idempotency key of the single-booking call: from the persisted operation and the booking, never from request order. */
export const innerKey = (operationId: string, bookingId: string): string => `bulk:${operationId}:${bookingId}`

/**
 * Bulk actions (ADR 0039, Phase 6C): ORCHESTRATION ONLY. For each selected booking it calls the existing single-booking service (`BookingOpsService.assign` /
 * `.acknowledge`), which keeps its own permission check, row lock, version check, idempotency and audit; this service updates no booking by any other path.
 * Three layers: the bulk capability (here), the booking's visibility within the tenant (the single-booking service finds it only inside the caller's tenant), and the exact
 * single-booking permission (there, per booking). One item's failure never authorises, blocks or rolls back another. Bounded and synchronous (100 items, one at a time).
 */
@Injectable()
export class BookingBulkService {
  private readonly logger = new Logger(BookingBulkService.name)
  constructor(private readonly db: BookingOpsDatabase, private readonly ops: BookingOpsService) {}

  async submit(tenantId: string, userId: string, access: BookingAccessView, body: unknown, requestId: string, now = new Date()): Promise<BookingBulkOperationView> {
    const parsed = validateBulkRequest(body)
    if (!parsed.ok) throw new BadRequestException({ message: parsed.issues[0].message, code: parsed.issues[0].code, issues: parsed.issues })
    const req = parsed.value
    if (access.level !== 'OPERATOR' || !access.permissions.includes(BOOKING_BULK_PERMISSION[req.action])) throw new ForbiddenException({ message: 'You do not have permission to run this bulk action', code: BOOKING_BULK_FAILURE.forbidden })
    const fp = bulkFingerprint(req)

    let operationId: string; let replayed = false
    try {
      operationId = await this.db.withTenantWrite(tenantId, async (tx) => {
        const op = await tx.bookingBulkOperation.create({ data: {
          tenantId, requestedByUserId: userId, actionType: req.action, actionPayload: req.payload as Prisma.InputJsonObject, idempotencyKey: req.idempotencyKey, requestFingerprint: fp, requestedCount: req.bookingIds.length,
        }, select: { id: true } })
        await tx.bookingBulkOperationItem.createMany({ data: req.bookingIds.map((bookingId, position) => ({ tenantId, operationId: op.id, bookingId, position })) })
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.bulk.requested', entityType: 'booking_bulk_operation', entityId: op.id, payload: { actionType: req.action, requestedCount: req.bookingIds.length, requestId } }] })
        return op.id
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      // The same request again (a retry, a double click, a concurrent duplicate): the database key found the first one. Return it; never apply anything twice.
      const existing = await this.db.withTenant(tenantId, (tx) => tx.bookingBulkOperation.findFirst({ where: { tenantId, requestedByUserId: userId, actionType: req.action, idempotencyKey: req.idempotencyKey }, select: { id: true, requestFingerprint: true } }))
      if (!existing) throw error
      if (existing.requestFingerprint !== fp) throw new ConflictException({ message: 'This idempotency key was already used for a different bulk request', code: BOOKING_BULK_FAILURE.idempotencyConflict })
      operationId = existing.id; replayed = true
    }
    await this.process(tenantId, userId, access, operationId, req, requestId, now)
    return this.view(tenantId, operationId, replayed)
  }

  /** Only the person who asked can read an operation (and needs `booking.bulk.read`, checked by the route). Anyone else gets a 404. */
  async get(tenantId: string, userId: string, operationId: string): Promise<BookingBulkOperationView> {
    const found = await this.db.withTenant(tenantId, (tx) => tx.bookingBulkOperation.findFirst({ where: { id: operationId, tenantId, requestedByUserId: userId }, select: { id: true } }))
    if (!found) throw new NotFoundException({ message: 'Bulk action not found', code: BOOKING_BULK_FAILURE.notFound })
    return this.view(tenantId, operationId, false)
  }

  // ---- processing -----------------------------------------------------------------------------------------------------
  private async process(tenantId: string, userId: string, access: BookingAccessView, operationId: string, req: BookingBulkRequest, requestId: string, now: Date): Promise<void> {
    const claimed = await this.db.withTenantWrite(tenantId, async (tx) => {
      const fresh = await tx.bookingBulkOperation.updateMany({ where: { id: operationId, tenantId, status: 'PENDING' }, data: { status: 'PROCESSING', startedAt: now, updatedAt: new Date() } })
      if (fresh.count === 1) return true
      const stale = await tx.bookingBulkOperation.updateMany({ where: { id: operationId, tenantId, status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }, data: { updatedAt: new Date() } })
      return stale.count === 1
    })
    if (!claimed) return // finished already, or another request is processing it right now
    const items = await this.db.withTenant(tenantId, (tx) => tx.bookingBulkOperationItem.findMany({ where: { tenantId, operationId, status: 'PENDING' }, orderBy: { position: 'asc' }, select: { id: true, bookingId: true } }))
    for (const item of items) {
      const outcome = await this.runItem(tenantId, userId, access, operationId, item.bookingId, req, requestId)
      await this.db.withTenantWrite(tenantId, async (tx) => {
        const set = await tx.bookingBulkOperationItem.updateMany({ where: { id: item.id, tenantId, status: 'PENDING' }, data: outcome === 'OK' ? { status: 'SUCCEEDED', processedAt: new Date() } : { status: 'FAILED', errorCode: outcome, processedAt: new Date() } })
        if (set.count === 1) await tx.bookingBulkOperation.updateMany({ where: { id: operationId, tenantId }, data: { processedCount: { increment: 1 }, ...(outcome === 'OK' ? { succeededCount: { increment: 1 } } : { failedCount: { increment: 1 } }), updatedAt: new Date() } })
      })
    }
    await this.db.withTenantWrite(tenantId, async (tx) => {
      const op = await tx.bookingBulkOperation.findFirst({ where: { id: operationId, tenantId }, select: { requestedCount: true, processedCount: true, succeededCount: true, failedCount: true } })
      if (!op || op.processedCount !== op.requestedCount) return
      const status = finalBulkStatus(op.succeededCount, op.failedCount)
      const done = await tx.bookingBulkOperation.updateMany({ where: { id: operationId, tenantId, status: 'PROCESSING' }, data: { status, completedAt: new Date(), updatedAt: new Date() } })
      if (done.count === 1) await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.bulk.completed', entityType: 'booking_bulk_operation', entityId: operationId, payload: { actionType: req.action, status, requestedCount: op.requestedCount, succeededCount: op.succeededCount, failedCount: op.failedCount, requestId } }] })
    })
  }

  /** One booking, through the existing service. Re-reads the CURRENT state each time; a booking that changed since it was selected is judged as it is now. */
  private async runItem(tenantId: string, userId: string, access: BookingAccessView, operationId: string, bookingId: string, req: BookingBulkRequest, requestId: string): Promise<'OK' | BookingBulkItemError> {
    const key = innerKey(operationId, bookingId)
    try {
      // Resume safety: if the single-booking effect with this key already exists (a crash after it, before the item was marked), the item is done. Never applied twice.
      const applied = await this.db.withTenant(tenantId, (tx) => tx.bookingEvent.findUnique({ where: { tenantId_bookingId_idempotencyKey: { tenantId, bookingId, idempotencyKey: key } }, select: { id: true } }))
      if (applied) return 'OK'
      const state = await this.db.withTenant(tenantId, (tx) => tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, opsState: { select: { version: true } } } }))
      if (!state) return 'NOT_FOUND'
      const expectedVersion = state.opsState?.version ?? 0
      if (req.action === 'ASSIGN_OWNER') await this.ops.assign(tenantId, userId, access, bookingId, { assigneeUserId: req.payload.assigneeUserId, expectedVersion }, key, requestId)
      else await this.ops.acknowledge(tenantId, userId, access, bookingId, { expectedVersion }, key, requestId)
      return 'OK'
    } catch (error) {
      const code = mapBulkItemError(error)
      if (code === 'INTERNAL_ERROR') this.logger.error(`Bulk item failed unexpectedly (operation ${operationId}): ${error instanceof Error ? error.name : 'unknown'}`) // no message, no booking data
      return code
    }
  }

  private async view(tenantId: string, operationId: string, replayed: boolean): Promise<BookingBulkOperationView> {
    return this.db.withTenant(tenantId, async (tx) => {
      const op = await tx.bookingBulkOperation.findFirstOrThrow({ where: { id: operationId, tenantId } })
      const items = await tx.bookingBulkOperationItem.findMany({ where: { tenantId, operationId }, orderBy: { position: 'asc' } })
      const refs = await tx.booking.findMany({ where: { tenantId, id: { in: items.map((i) => i.bookingId) } }, select: { id: true, reference: true } })
      const ref = new Map(refs.map((r) => [r.id, r.reference]))
      const failuresByCode: BookingBulkOperationView['failuresByCode'] = {}
      for (const i of items) if (i.errorCode) failuresByCode[i.errorCode as BookingBulkItemError] = (failuresByCode[i.errorCode as BookingBulkItemError] ?? 0) + 1
      return {
        id: op.id, action: op.actionType, status: op.status, requestedCount: op.requestedCount, processedCount: op.processedCount, succeededCount: op.succeededCount, failedCount: op.failedCount,
        createdAt: op.createdAt.toISOString(), completedAt: op.completedAt?.toISOString() ?? null, replayed, failuresByCode,
        items: items.map((i) => ({ bookingId: i.bookingId, reference: ref.get(i.bookingId) ?? null, status: i.status, errorCode: (i.errorCode as BookingBulkItemError | null) ?? null })),
      }
    })
  }
}
