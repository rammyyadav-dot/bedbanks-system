import { ConflictException, Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from './audit.service'

export const SUPPLIER_MUTATION_OPERATIONS = ['PREBOOK', 'BOOK', 'CANCEL'] as const
export type SupplierMutationOperationName = (typeof SUPPLIER_MUTATION_OPERATIONS)[number]
export type SupplierMutationState = 'PREPARED' | 'SENDING' | 'ACKNOWLEDGED' | 'REJECTED' | 'UNKNOWN' | 'RESOLVED'

export interface SupplierMutationView {
  id: string
  tenantId: string
  bookingId: string
  holdId: string
  supplierKey: string
  operation: SupplierMutationOperationName
  idempotencyKey: string
  requestId: string
  status: SupplierMutationState
  attemptedAt: Date | null
  acknowledgedAt: Date | null
  resolvedAt: Date | null
  supplierReference: string | null
  supplierStatus: string | null
  requestFingerprint: string
  failureCategory: string | null
  failureCode: string | null
  createdAt: Date
  updatedAt: Date
}

export interface PrepareSupplierMutationInput {
  tenantId: string
  userId: string
  bookingId: string
  holdId: string
  supplierKey: string
  operation: SupplierMutationOperationName
  idempotencyKey: string
  requestId: string
  fingerprint: string
}

/** Safe request fingerprint. Commercial identity only: no guest names, contact details, or secrets. */
export function supplierMutationFingerprint(input: {
  offerId: string
  searchId: string
  holdId: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  currency: string
  totalMinor: number
}): string {
  const canonical = [
    input.offerId, input.searchId, input.holdId, input.checkIn, input.checkOut,
    String(input.rooms), String(input.adults), String(input.children), input.currency, String(input.totalMinor),
  ].join('|')
  return createHash('sha256').update(canonical).digest('hex')
}

/** Supplier success that is durable in the journal, not merely an in-memory adapter response. */
export function supplierMutationAcceptedReference(record: Pick<SupplierMutationView, 'status' | 'supplierStatus' | 'supplierReference'> | null | undefined): string | null {
  if (!record?.supplierReference) return null
  if (record.status === 'ACKNOWLEDGED') return record.supplierReference
  if (record.status === 'RESOLVED' && record.supplierStatus === 'accepted') return record.supplierReference
  return null
}

type MutationRow = SupplierMutationView

/**
 * Persists the outbound supplier boundary independently of Booking and AuditEvent.
 * A failed journal write must prevent the adapter call. Audit emission is best-effort
 * and never rolls back a committed transition.
 */
@Injectable()
export class SupplierMutationJournalService {
  private readonly logger = new Logger(SupplierMutationJournalService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AgentAuditService,
  ) {}

  async prepare(input: PrepareSupplierMutationInput): Promise<SupplierMutationView> {
    try {
      const created = await this.prisma.withTenant(input.tenantId, tx => tx.supplierMutation.create({
        data: {
          tenantId: input.tenantId,
          bookingId: input.bookingId,
          holdId: input.holdId,
          supplierKey: input.supplierKey,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
          status: 'PREPARED',
          requestFingerprint: input.fingerprint,
        },
      }))
      const view = this.view(created)
      await this.auditTransition(view, input.userId, 'supplier.mutation.prepared')
      return view
    } catch (error) {
      if (!this.unique(error)) throw error
      const existing = await this.findLogical(input.tenantId, input.bookingId, input.operation, input.idempotencyKey)
      if (!existing) throw error
      if (existing.requestFingerprint !== input.fingerprint || existing.holdId !== input.holdId || existing.supplierKey !== input.supplierKey) {
        throw new ConflictException('Supplier mutation idempotency key conflicts')
      }
      return existing
    }
  }

  /**
   * Crosses the outbound boundary. Only the caller that receives claimed=true may invoke the adapter.
   * Throws only when the PREPARED → SENDING write itself fails, in which case the supplier was not called.
   */
  async markSending(tenantId: string, mutationId: string, requestId: string, userId: string): Promise<{ claimed: boolean; record: SupplierMutationView }> {
    const attemptedAt = new Date()
    const updated = await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.updateMany({
      where: { id: mutationId, tenantId, status: 'PREPARED' },
      data: { status: 'SENDING', attemptedAt, requestId },
    }))
    const record = await this.require(tenantId, mutationId)
    if (updated.count === 1) {
      await this.auditTransition(record, userId, 'supplier.mutation.sending')
      return { claimed: true, record }
    }
    return { claimed: false, record }
  }

  async acknowledge(input: { tenantId: string; userId: string; mutationId: string; supplierReference: string }): Promise<SupplierMutationView> {
    const current = await this.require(input.tenantId, input.mutationId)
    if (supplierMutationAcceptedReference(current) === input.supplierReference) return current
    if (current.status === 'ACKNOWLEDGED' || (current.status === 'RESOLVED' && current.supplierStatus === 'accepted')) {
      throw new ConflictException('Supplier reference does not match')
    }
    const updated = await this.prisma.withTenant(input.tenantId, tx => tx.supplierMutation.updateMany({
      where: { id: input.mutationId, tenantId: input.tenantId, status: { in: ['SENDING', 'UNKNOWN'] } },
      data: {
        status: 'ACKNOWLEDGED',
        supplierReference: input.supplierReference,
        supplierStatus: 'accepted',
        acknowledgedAt: new Date(),
        failureCategory: null,
        failureCode: null,
      },
    }))
    const record = await this.require(input.tenantId, input.mutationId)
    if (updated.count === 1) {
      await this.auditTransition(record, input.userId, 'supplier.mutation.acknowledged')
      return record
    }
    if (supplierMutationAcceptedReference(record) === input.supplierReference) return record
    throw new ConflictException('Supplier mutation cannot be acknowledged')
  }

  async reject(input: { tenantId: string; userId: string; mutationId: string; failureCategory: string; failureCode: string }): Promise<SupplierMutationView> {
    const current = await this.require(input.tenantId, input.mutationId)
    if (current.status === 'REJECTED' || current.status === 'RESOLVED') return current
    const updated = await this.prisma.withTenant(input.tenantId, tx => tx.supplierMutation.updateMany({
      where: { id: input.mutationId, tenantId: input.tenantId, status: { in: ['PREPARED', 'SENDING'] } },
      data: {
        status: 'REJECTED',
        supplierStatus: 'rejected',
        failureCategory: input.failureCategory,
        failureCode: input.failureCode,
        resolvedAt: null,
      },
    }))
    const record = await this.require(input.tenantId, input.mutationId)
    if (updated.count === 1) await this.auditTransition(record, input.userId, 'supplier.mutation.rejected')
    else if (record.status !== 'REJECTED') throw new ConflictException('Supplier mutation cannot be rejected')
    return record
  }

  async markUnknown(input: { tenantId: string; userId: string; mutationId: string; failureCategory: string; failureCode: string }): Promise<SupplierMutationView> {
    const current = await this.require(input.tenantId, input.mutationId)
    if (current.status === 'UNKNOWN') return current
    if (current.status === 'ACKNOWLEDGED' || current.status === 'RESOLVED' || current.status === 'REJECTED') return current
    const updated = await this.prisma.withTenant(input.tenantId, tx => tx.supplierMutation.updateMany({
      where: { id: input.mutationId, tenantId: input.tenantId, status: 'SENDING' },
      data: { status: 'UNKNOWN', failureCategory: input.failureCategory, failureCode: input.failureCode },
    }))
    const record = await this.require(input.tenantId, input.mutationId)
    if (updated.count === 1) await this.auditTransition(record, input.userId, 'supplier.mutation.unknown')
    else if (record.status !== 'UNKNOWN' && record.status !== 'ACKNOWLEDGED' && record.status !== 'RESOLVED') {
      throw new ConflictException('Supplier mutation cannot be marked unknown')
    }
    return record
  }

  async resolve(input: { tenantId: string; userId: string; mutationId: string; supplierStatus: string }): Promise<SupplierMutationView> {
    const current = await this.require(input.tenantId, input.mutationId)
    if (current.status === 'RESOLVED') return current
    const updated = await this.prisma.withTenant(input.tenantId, tx => tx.supplierMutation.updateMany({
      where: { id: input.mutationId, tenantId: input.tenantId, status: { not: 'RESOLVED' } },
      data: { status: 'RESOLVED', supplierStatus: input.supplierStatus, resolvedAt: new Date() },
    }))
    const record = await this.require(input.tenantId, input.mutationId)
    if (updated.count === 1) await this.auditTransition(record, input.userId, 'supplier.mutation.reconciled')
    return record
  }

  async findForBooking(tenantId: string, bookingId: string, operation: SupplierMutationOperationName = 'PREBOOK'): Promise<SupplierMutationView | null> {
    const row = await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.findFirst({
      where: { tenantId, bookingId, operation },
      orderBy: { createdAt: 'desc' },
    }))
    return row ? this.view(row) : null
  }

  async findById(tenantId: string, mutationId: string): Promise<SupplierMutationView | null> {
    const row = await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.findFirst({ where: { id: mutationId, tenantId } }))
    return row ? this.view(row) : null
  }

  private async findLogical(tenantId: string, bookingId: string, operation: SupplierMutationOperationName, idempotencyKey: string): Promise<SupplierMutationView | null> {
    const row = await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.findFirst({
      where: { tenantId, bookingId, operation, idempotencyKey },
    }))
    return row ? this.view(row) : null
  }

  private async require(tenantId: string, mutationId: string): Promise<SupplierMutationView> {
    const row = await this.findById(tenantId, mutationId)
    if (!row) throw new ConflictException('Supplier mutation is unavailable')
    return row
  }

  private async auditTransition(record: SupplierMutationView, userId: string, action: string): Promise<void> {
    this.logger.log(JSON.stringify({
      requestId: record.requestId,
      bookingId: record.bookingId,
      mutationId: record.id,
      supplier: record.supplierKey,
      operation: record.operation,
      state: record.status,
      failureCategory: record.failureCategory,
    }))
    try {
      await this.audit.record({
        tenantId: record.tenantId,
        userId,
        action,
        entityType: 'supplier_mutation',
        entityId: record.id,
        payload: {
          requestId: record.requestId,
          bookingId: record.bookingId,
          mutationId: record.id,
          holdId: record.holdId,
          supplierKey: record.supplierKey,
          operation: record.operation,
          state: record.status,
          ...(record.supplierReference ? { supplierReference: record.supplierReference } : {}),
          ...(record.failureCategory ? { failureCategory: record.failureCategory } : {}),
          ...(record.failureCode ? { failureCode: record.failureCode } : {}),
        },
      })
    } catch {
      this.logger.error(`Could not audit supplier mutation ${action} mutation=${record.id} booking=${record.bookingId}`)
    }
  }

  private view(row: MutationRow): SupplierMutationView {
    return {
      id: row.id,
      tenantId: row.tenantId,
      bookingId: row.bookingId,
      holdId: row.holdId,
      supplierKey: row.supplierKey,
      operation: row.operation,
      idempotencyKey: row.idempotencyKey,
      requestId: row.requestId,
      status: row.status,
      attemptedAt: row.attemptedAt,
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      supplierReference: row.supplierReference,
      supplierStatus: row.supplierStatus,
      requestFingerprint: row.requestFingerprint,
      failureCategory: row.failureCategory,
      failureCode: row.failureCode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private unique(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  }
}
