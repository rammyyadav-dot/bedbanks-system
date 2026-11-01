import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  SAVED_VIEW_FAILURE, SAVED_VIEW_MAX_PER_USER, normalizeBookingQuery, normalizeSavedViewInput, resolveSavedView,
  type BookingAccessView, type BookingQueryIssue, type BookingSavedViewList, type BookingSavedViewView, type SavedViewUpdateRequest, type SavedViewWriteRequest, type SavedViewWriteResult, type BookingColumnId,
} from '@bedbanks/contracts'
import { assertQueryAccess } from './booking-list-query'
import { BookingOpsDatabase } from './booking-ops-database'

type Row = { id: string; name: string; description: string | null; filterVersion: number; filtersJson: Prisma.JsonValue; sortJson: Prisma.JsonValue; visibleColumnsJson: Prisma.JsonValue | null; defaultSlot: number | null; version: number; createdAt: Date; updatedAt: Date }

/**
 * Personal saved views of the booking list (ADR 0039, Phase 6B). Every statement is scoped by the tenant AND the owner taken from the authenticated session; a body
 * can name neither. Another person's view is a 404, never a 403, so ids cannot be probed. A view is re-validated against the current grammar and the current
 * caller's access whenever it is read, so it can never carry more visibility than its owner has today. Writes are one transaction with their audit event.
 */
@Injectable()
export class BookingSavedViewsService {
  constructor(private readonly db: BookingOpsDatabase) {}

  private view(row: Row, access: BookingAccessView): BookingSavedViewView {
    const restrictedBy = (query: Parameters<typeof assertQueryAccess>[0]): BookingQueryIssue[] => {
      try { assertQueryAccess(query, access); return [] } catch (error) {
        if (error instanceof ForbiddenException) return [{ field: '*', code: 'INVALID_VALUE', message: 'This view uses a filter you no longer have access to' }]
        throw error
      }
    }
    return {
      id: row.id, name: row.name, description: row.description, filterVersion: row.filterVersion,
      filters: (row.filtersJson && typeof row.filtersJson === 'object' && !Array.isArray(row.filtersJson) ? row.filtersJson : {}) as Record<string, string>,
      sort: (row.sortJson && typeof row.sortJson === 'object' && !Array.isArray(row.sortJson) ? row.sortJson : { sort: 'created', dir: 'desc' }) as { sort: string; dir: 'asc' | 'desc' },
      visibleColumns: Array.isArray(row.visibleColumnsJson) ? (row.visibleColumnsJson as BookingColumnId[]) : null,
      isDefault: row.defaultSlot === 1, version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      resolution: resolveSavedView({ filterVersion: row.filterVersion, filters: row.filtersJson, sort: row.sortJson }, restrictedBy),
    }
  }

  async list(tenantId: string, userId: string, access: BookingAccessView): Promise<BookingSavedViewList> {
    const rows = await this.db.withTenant(tenantId, (tx) => tx.bookingSavedView.findMany({ where: { tenantId, ownerUserId: userId }, orderBy: [{ defaultSlot: { sort: 'asc', nulls: 'last' } }, { nameKey: 'asc' }], take: SAVED_VIEW_MAX_PER_USER }))
    return { items: rows.map((r) => this.view(r, access)), max: SAVED_VIEW_MAX_PER_USER }
  }

  async get(tenantId: string, userId: string, access: BookingAccessView, id: string): Promise<BookingSavedViewView> {
    const row = await this.db.withTenant(tenantId, (tx) => tx.bookingSavedView.findFirst({ where: { id, tenantId, ownerUserId: userId } }))
    if (!row) throw this.notFound()
    return this.view(row, access)
  }

  async create(tenantId: string, userId: string, access: BookingAccessView, body: SavedViewWriteRequest, requestId: string): Promise<SavedViewWriteResult> {
    const input = this.validate(body, access)
    try {
      return await this.db.withTenantWrite(tenantId, async (tx) => {
        const count = await tx.bookingSavedView.count({ where: { tenantId, ownerUserId: userId } })
        if (count >= SAVED_VIEW_MAX_PER_USER) throw new ConflictException({ message: `You can keep at most ${SAVED_VIEW_MAX_PER_USER} saved views. Delete one first.`, code: SAVED_VIEW_FAILURE.limit })
        const created = await tx.bookingSavedView.create({ data: {
          tenantId, ownerUserId: userId, name: input.name, nameKey: input.nameKey, description: input.description, filterVersion: input.filterVersion,
          filtersJson: input.filters, sortJson: { ...input.sort }, visibleColumnsJson: input.visibleColumns ?? Prisma.DbNull,
        }, select: { id: true, version: true } })
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.savedview.created', entityType: 'booking_saved_view', entityId: created.id, payload: { requestId } }] })
        return { id: created.id, version: created.version, isDefault: false }
      })
    } catch (error) { throw this.mapUnique(error) }
  }

  async update(tenantId: string, userId: string, access: BookingAccessView, id: string, body: SavedViewUpdateRequest, requestId: string): Promise<SavedViewWriteResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isInteger(body.expectedVersion)) throw new BadRequestException({ message: 'expectedVersion is required', code: SAVED_VIEW_FAILURE.invalid })
    // An update names only what it changes, and only these fields: no owner, no tenant, no ids.
    const unknown = Object.keys(body).filter((k) => !['expectedVersion', 'name', 'description', 'filters', 'sort', 'visibleColumns'].includes(k))
    if (unknown.length) throw new BadRequestException({ message: `Unsupported field "${unknown[0].slice(0, 40)}"`, code: SAVED_VIEW_FAILURE.invalid, issues: unknown.map((field) => ({ field, code: 'UNSUPPORTED_FIELD', message: `Unsupported field "${field.slice(0, 40)}"` })) })
    try {
      return await this.db.withTenantWrite(tenantId, async (tx) => {
        const row = await tx.bookingSavedView.findFirst({ where: { id, tenantId, ownerUserId: userId } })
        if (!row) throw this.notFound()
        if (row.version !== body.expectedVersion) throw new ConflictException({ message: 'This view changed since you opened it. Reload and try again.', code: SAVED_VIEW_FAILURE.stale })
        const changesQuery = body.filters !== undefined || body.sort !== undefined
        // A rename (or a column change) never re-reads the stored filters, so a view the grammar no longer accepts can still be renamed, fixed or deleted.
        const merged = { name: body.name ?? row.name, description: body.description === undefined ? row.description : body.description, filters: changesQuery ? (body.filters ?? row.filtersJson) : {}, sort: changesQuery ? (body.sort ?? row.sortJson) : undefined,
          visibleColumns: body.visibleColumns === undefined ? row.visibleColumnsJson : body.visibleColumns }
        const input = this.validate(merged as SavedViewWriteRequest, access, changesQuery)
        const changed = await tx.bookingSavedView.updateMany({ where: { id, tenantId, ownerUserId: userId, version: row.version }, data: {
          name: input.name, nameKey: input.nameKey, description: input.description, filterVersion: changesQuery ? input.filterVersion : row.filterVersion,
          filtersJson: changesQuery ? input.filters : (row.filtersJson as Prisma.InputJsonValue), sortJson: changesQuery ? { ...input.sort } : (row.sortJson as Prisma.InputJsonValue),
          visibleColumnsJson: input.visibleColumns ?? Prisma.DbNull, version: { increment: 1 }, updatedAt: new Date(),
        } })
        if (changed.count !== 1) throw new ConflictException({ message: 'This view changed since you opened it. Reload and try again.', code: SAVED_VIEW_FAILURE.stale })
        const fields = [body.name !== undefined && 'name', body.description !== undefined && 'description', changesQuery && 'query', body.visibleColumns !== undefined && 'columns'].filter(Boolean)
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.savedview.updated', entityType: 'booking_saved_view', entityId: id, payload: { fields, requestId } }] })
        return { id, version: row.version + 1, isDefault: row.defaultSlot === 1 }
      })
    } catch (error) { throw this.mapUnique(error) }
  }

  async remove(tenantId: string, userId: string, id: string, requestId: string): Promise<{ id: string }> {
    return this.db.withTenantWrite(tenantId, async (tx) => {
      const gone = await tx.bookingSavedView.deleteMany({ where: { id, tenantId, ownerUserId: userId } })
      if (gone.count !== 1) throw this.notFound()
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.savedview.deleted', entityType: 'booking_saved_view', entityId: id, payload: { requestId } }] })
      return { id }
    })
  }

  async setDefault(tenantId: string, userId: string, id: string, requestId: string): Promise<SavedViewWriteResult> {
    return this.db.withTenantWrite(tenantId, async (tx) => {
      const row = await tx.bookingSavedView.findFirst({ where: { id, tenantId, ownerUserId: userId }, select: { id: true, version: true, defaultSlot: true } })
      if (!row) throw this.notFound()
      if (row.defaultSlot === 1) return { id, version: row.version, isDefault: true }
      // Clear the previous default first: the unique key over (tenant, owner, default_slot) allows only one.
      await tx.bookingSavedView.updateMany({ where: { tenantId, ownerUserId: userId, defaultSlot: 1 }, data: { defaultSlot: null, updatedAt: new Date() } })
      await tx.bookingSavedView.updateMany({ where: { id, tenantId, ownerUserId: userId }, data: { defaultSlot: 1, version: { increment: 1 }, updatedAt: new Date() } })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.savedview.default_set', entityType: 'booking_saved_view', entityId: id, payload: { requestId } }] })
      return { id, version: row.version + 1, isDefault: true }
    })
  }

  /** "Reset to system default": the person has no default view. Idempotent. */
  async clearDefault(tenantId: string, userId: string, requestId: string): Promise<{ cleared: number }> {
    return this.db.withTenantWrite(tenantId, async (tx) => {
      const cleared = await tx.bookingSavedView.updateMany({ where: { tenantId, ownerUserId: userId, defaultSlot: 1 }, data: { defaultSlot: null, updatedAt: new Date() } })
      if (cleared.count > 0) await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.savedview.default_cleared', entityType: 'booking_saved_view', entityId: userId, payload: { requestId } }] })
      return { cleared: cleared.count }
    })
  }

  // ---- internals ----------------------------------------------------------------------------------------------------
  /** Validates a write and refuses a view the caller could not run themselves: saving never grants more than opening does. */
  private validate(body: SavedViewWriteRequest, access: BookingAccessView, checkQuery = true) {
    const parsed = normalizeSavedViewInput(body)
    if (!parsed.ok) throw new BadRequestException({ message: parsed.issues[0]?.message ?? 'Invalid saved view', code: SAVED_VIEW_FAILURE.invalid, issues: parsed.issues })
    if (checkQuery) {
      const q = normalizeBookingQuery({ ...parsed.value.filters, sort: parsed.value.sort.sort, dir: parsed.value.sort.dir })
      if (q.ok) {
        try { assertQueryAccess(q.query, access) } catch (error) {
          if (error instanceof ForbiddenException) throw new ForbiddenException({ message: 'You cannot save a view that uses a filter you are not allowed to use', code: SAVED_VIEW_FAILURE.forbidden })
          throw error
        }
      }
    }
    return parsed.value
  }

  private notFound() { return new NotFoundException({ message: 'Saved view not found', code: SAVED_VIEW_FAILURE.notFound }) }

  private mapUnique(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return new ConflictException({ message: 'You already have a view with that name', code: SAVED_VIEW_FAILURE.nameTaken })
    return error
  }
}
