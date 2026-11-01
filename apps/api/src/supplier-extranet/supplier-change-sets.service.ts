import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { ExtranetChangeSetDetail, ExtranetChangeSetList, ExtranetChangeSetPreview, ExtranetChangeSetResult, ExtranetChangeSetStatus, ExtranetChangeSetSummary } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import type { ExistingAvailability, ImportPlan } from '../supply/calendar-import'
import { scanReferences } from '../supply/calendar-import'
import { SupplierExtranetService } from './supplier-extranet.service'
import { decodeCursor, encodeCursor } from './supplier-booking-cursor'
import { cellsSha256, validateSupplierCsv, type SupplierCsvReport } from './supplier-change-validation'
import type { ChangeSetTransitionDto, CreateChangeSetDto, ListChangeSetsQueryDto, ReplaceChangeSetDto } from './change-set.dto'

const READ = 'supplier.extranet.changes.read'
const AUTHOR = 'supplier.extranet.changes.author'
const KEY = /^[A-Za-z0-9._:-]{8,128}$/
const DEFAULT_LIMIT = 25
const VISIBLE_MAPPING = ['PENDING', 'MAPPED'] as const
const MAX_PLANS = 2000

const day = (value: Date): string => value.toISOString().slice(0, 10)
const fingerprint = (parts: unknown): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

/**
 * A supplier's availability change sets (ADR 0061 Amendment 3, slice 4a).
 *
 * The supplier prepares a CSV for one mapped hotel; it is validated with the staff calendar-import parser against ONLY the plans of the supplier's own
 * contracts, stored as a DRAFT, frozen on submit, and later reviewed and applied by staff. Nothing here writes DailyAvailability, DailyRate or RatePlan.
 * Every query runs under `withSupplier`, so row-level security limits it to the caller's organization as well as the explicit filters below. Every
 * transition writes an append-only event and an audit event; all four writes need an Idempotency-Key (one key = one logical request per organization).
 * Database triggers enforce the status edges and the frozen cells, whatever this code does.
 */
@Injectable()
export class SupplierChangeSetsService {
  constructor(private readonly prisma: PrismaService, private readonly extranet: SupplierExtranetService) {}

  // ---- reads -------------------------------------------------------------------------------------------------------------------------------
  async list(tenantId: string, userId: string, supplierId: string, query: ListChangeSetsQueryDto = {}): Promise<ExtranetChangeSetList> {
    await this.extranet.requirePermission(tenantId, userId, READ)
    const limit = query.limit ?? DEFAULT_LIMIT
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
    return this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const rows = await tx.supplierChangeSet.findMany({
        where: {
          tenantId, supplierId,
          ...(query.status ? { status: query.status } : {}),
          ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: { id: true, hotelId: true, status: true, version: true, cellCount: true, createdAt: true, submittedAt: true, hotel: { select: { name: true } } },
      })
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      return {
        changeSets: page.map((row) => this.summary(row)),
        nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      }
    })
  }

  async detail(tenantId: string, userId: string, supplierId: string, changeSetId: string): Promise<ExtranetChangeSetDetail> {
    await this.extranet.requirePermission(tenantId, userId, READ)
    return this.prisma.withSupplier(tenantId, supplierId, (tx) => this.load(tx, tenantId, supplierId, changeSetId))
  }

  /** Validates a file against this organization's plans for one hotel. Writes nothing. */
  async preview(tenantId: string, userId: string, supplierId: string, body: CreateChangeSetDto): Promise<ExtranetChangeSetPreview> {
    await this.extranet.requirePermission(tenantId, userId, AUTHOR)
    const report = await this.prisma.withSupplier(tenantId, supplierId, (tx) => this.validate(tx, tenantId, supplierId, body.hotelId, body.csv))
    return this.previewOf(report)
  }

  // ---- writes ------------------------------------------------------------------------------------------------------------------------------
  async create(tenantId: string, userId: string, supplierId: string, body: CreateChangeSetDto, rawKey: unknown, requestId?: string): Promise<ExtranetChangeSetResult> {
    await this.extranet.requirePermission(tenantId, userId, AUTHOR)
    const key = this.requireKey(rawKey)
    const fp = fingerprint(['create', body.hotelId, body.csv])
    return this.guarded(() => this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const replay = await this.replayOf(tx, tenantId, supplierId, key, fp)
      if (replay) return replay
      const report = await this.validate(tx, tenantId, supplierId, body.hotelId, body.csv)
      if (!report.ok) throw new UnprocessableEntityException({ code: 'CHANGE_SET_INVALID', message: 'The file has errors. Nothing was saved.', details: this.issues(report) })
      const sha = cellsSha256(report.cells)
      const created = await tx.supplierChangeSet.create({ data: { tenantId, supplierId, hotelId: body.hotelId, cellCount: report.cells.length, contentSha256: sha, createdByUserId: userId }, select: { id: true } })
      await this.storeCells(tx, tenantId, supplierId, created.id, report)
      await this.record(tx, { tenantId, supplierId, userId, changeSetId: created.id, action: 'created', from: null, to: 'DRAFT', key, fp, requestId, payload: { version: 1, cellCount: report.cells.length, contentSha256: sha } })
      return { changeSet: await this.load(tx, tenantId, supplierId, created.id), replayed: false }
    }))
  }

  async replace(tenantId: string, userId: string, supplierId: string, changeSetId: string, body: ReplaceChangeSetDto, rawKey: unknown, requestId?: string): Promise<ExtranetChangeSetResult> {
    await this.extranet.requirePermission(tenantId, userId, AUTHOR)
    const key = this.requireKey(rawKey)
    const fp = fingerprint(['replace', changeSetId, body.expectedVersion, body.csv])
    return this.guarded(() => this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const replay = await this.replayOf(tx, tenantId, supplierId, key, fp)
      if (replay) return replay
      const set = await this.lock(tx, tenantId, supplierId, changeSetId)
      this.requireStatus(set.status, ['DRAFT'], 'CHANGE_SET_NOT_DRAFT')
      this.requireVersion(set.version, body.expectedVersion)
      const report = await this.validate(tx, tenantId, supplierId, set.hotelId, body.csv)
      if (!report.ok) throw new UnprocessableEntityException({ code: 'CHANGE_SET_INVALID', message: 'The file has errors. The draft was not changed.', details: this.issues(report) })
      const sha = cellsSha256(report.cells)
      await tx.supplierChangeSetCell.deleteMany({ where: { tenantId, supplierId, changeSetId } })
      await this.storeCells(tx, tenantId, supplierId, changeSetId, report)
      await tx.supplierChangeSet.update({ where: { tenantId_supplierId_id: { tenantId, supplierId, id: changeSetId } }, data: { version: { increment: 1 }, cellCount: report.cells.length, contentSha256: sha } })
      await this.record(tx, { tenantId, supplierId, userId, changeSetId, action: 'replaced', from: 'DRAFT', to: 'DRAFT', key, fp, requestId, payload: { version: set.version + 1, cellCount: report.cells.length, contentSha256: sha } })
      return { changeSet: await this.load(tx, tenantId, supplierId, changeSetId), replayed: false }
    }))
  }

  async submit(tenantId: string, userId: string, supplierId: string, changeSetId: string, body: ChangeSetTransitionDto, rawKey: unknown, requestId?: string, now = new Date()): Promise<ExtranetChangeSetResult> {
    return this.transition('submit', tenantId, userId, supplierId, changeSetId, body, rawKey, requestId, now)
  }

  async withdraw(tenantId: string, userId: string, supplierId: string, changeSetId: string, body: ChangeSetTransitionDto, rawKey: unknown, requestId?: string, now = new Date()): Promise<ExtranetChangeSetResult> {
    return this.transition('withdraw', tenantId, userId, supplierId, changeSetId, body, rawKey, requestId, now)
  }

  private async transition(verb: 'submit' | 'withdraw', tenantId: string, userId: string, supplierId: string, changeSetId: string, body: ChangeSetTransitionDto, rawKey: unknown, requestId: string | undefined, now: Date): Promise<ExtranetChangeSetResult> {
    await this.extranet.requirePermission(tenantId, userId, AUTHOR)
    const key = this.requireKey(rawKey)
    const fp = fingerprint([verb, changeSetId, body.expectedVersion])
    return this.guarded(() => this.prisma.withSupplier(tenantId, supplierId, async (tx) => {
      const replay = await this.replayOf(tx, tenantId, supplierId, key, fp)
      if (replay) return replay
      const set = await this.lock(tx, tenantId, supplierId, changeSetId)
      this.requireStatus(set.status, verb === 'submit' ? ['DRAFT'] : ['DRAFT', 'SUBMITTED'], verb === 'submit' ? 'CHANGE_SET_NOT_DRAFT' : 'CHANGE_SET_NOT_WITHDRAWABLE')
      this.requireVersion(set.version, body.expectedVersion)
      const to: ExtranetChangeSetStatus = verb === 'submit' ? 'SUBMITTED' : 'WITHDRAWN'
      await tx.supplierChangeSet.update({ where: { tenantId_supplierId_id: { tenantId, supplierId, id: changeSetId } }, data: verb === 'submit' ? { status: to, submittedAt: now, submittedByUserId: userId } : { status: to } })
      await this.record(tx, { tenantId, supplierId, userId, changeSetId, action: verb === 'submit' ? 'submitted' : 'withdrawn', from: set.status, to, key, fp, requestId, payload: { version: set.version, cellCount: set.cellCount, contentSha256: set.contentSha256 } })
      return { changeSet: await this.load(tx, tenantId, supplierId, changeSetId), replayed: false }
    }))
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------------------------
  private requireKey(raw: unknown): string {
    if (typeof raw !== 'string' || !KEY.test(raw)) throw new BadRequestException({ message: 'An Idempotency-Key header of 8 to 128 letters, digits or . _ : - is required', code: 'IDEMPOTENCY_KEY_REQUIRED' })
    return raw
  }

  private requireStatus(current: ExtranetChangeSetStatus, allowed: readonly ExtranetChangeSetStatus[], code: string): void {
    if (!allowed.includes(current)) throw new ConflictException({ code, message: `This change set is ${current.toLowerCase()} and cannot be changed this way.`, currentStatus: current })
  }

  private requireVersion(current: number, expected: number): void {
    if (current !== expected) throw new ConflictException({ code: 'STALE_VERSION', message: 'The change set changed since you loaded it. Reload and try again.', currentVersion: current })
  }

  /** A concurrent request that lost a unique-key race is a conflict the caller may retry, not a server error. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'CHANGE_SET_CONFLICT', message: 'A concurrent request used the same Idempotency-Key. Retry.' })
      throw error
    }
  }

  /** Locks the set row (serialising writers) and returns the fields the guards need. 404 for any set outside this organization. */
  private async lock(tx: Prisma.TransactionClient, tenantId: string, supplierId: string, changeSetId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "supplier_change_sets" WHERE "id" = ${changeSetId} AND "tenant_id" = ${tenantId} AND "supplier_id" = ${supplierId} FOR UPDATE`
    if (locked.length !== 1) throw new NotFoundException({ message: 'Change set not found', code: 'CHANGE_SET_NOT_FOUND' })
    return tx.supplierChangeSet.findFirstOrThrow({ where: { id: changeSetId, tenantId, supplierId }, select: { id: true, hotelId: true, status: true, version: true, cellCount: true, contentSha256: true } })
  }

  private async replayOf(tx: Prisma.TransactionClient, tenantId: string, supplierId: string, key: string, fp: string): Promise<ExtranetChangeSetResult | null> {
    const earlier = await tx.supplierChangeSetEvent.findFirst({ where: { tenantId, supplierId, idempotencyKey: key }, select: { changeSetId: true, requestFingerprint: true } })
    if (!earlier) return null
    if (earlier.requestFingerprint !== fp) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'This idempotency key was already used for a different request' })
    return { changeSet: await this.load(tx, tenantId, supplierId, earlier.changeSetId), replayed: true }
  }

  private async record(tx: Prisma.TransactionClient, e: { tenantId: string; supplierId: string; userId: string; changeSetId: string; action: string; from: ExtranetChangeSetStatus | null; to: ExtranetChangeSetStatus; key: string; fp: string; requestId?: string; payload: Record<string, unknown> }): Promise<void> {
    await tx.supplierChangeSetEvent.createMany({ data: [{ tenantId: e.tenantId, supplierId: e.supplierId, changeSetId: e.changeSetId, action: e.action, fromStatus: e.from, toStatus: e.to, actorUserId: e.userId, requestId: e.requestId ?? null, idempotencyKey: e.key, requestFingerprint: e.fp, payload: e.payload as Prisma.InputJsonValue }] })
    // Facts only: ids, counts, version and the content hash. Never free text.
    await tx.auditEvent.createMany({ data: [{ tenantId: e.tenantId, userId: e.userId, actorType: 'USER', action: `supplier.change_set.${e.action}`, entityType: 'supplier_change_set', entityId: e.changeSetId, payload: { ...e.payload, supplierId: e.supplierId, from: e.from, to: e.to, requestId: e.requestId ?? null } as Prisma.InputJsonValue }] })
  }

  private async storeCells(tx: Prisma.TransactionClient, tenantId: string, supplierId: string, changeSetId: string, report: SupplierCsvReport): Promise<void> {
    await tx.supplierChangeSetCell.createMany({ data: report.cells.map((cell) => ({
      tenantId, supplierId, changeSetId, ratePlanId: cell.ratePlanId, stayDate: new Date(`${cell.stayDate}T00:00:00.000Z`), allotment: cell.allotment, stopSell: cell.stopSell,
      minStay: cell.minStay, releaseDays: cell.releaseDays, expectedUpdatedAt: cell.expectedUpdatedAt ? new Date(cell.expectedUpdatedAt) : null,
    })) })
  }

  /** The plans this organization may change at this hotel: its own contracts' plans, at a hotel mapped to it. Anything else does not exist for the caller. */
  private async validate(tx: Prisma.TransactionClient, tenantId: string, supplierId: string, hotelId: string, csv: string): Promise<SupplierCsvReport> {
    const mapping = await tx.supplierHotelMapping.findFirst({ where: { tenantId, supplierId, hotelId, status: { in: [...VISIBLE_MAPPING] } }, select: { id: true } })
    if (!mapping) throw new NotFoundException('Hotel not found')
    const plans = await tx.ratePlan.findMany({
      where: {
        tenantId,
        roomType: { hotelId },
        contract: { tenantId, supplierId, OR: [{ supplierHotelMappingId: null }, { supplierHotelMapping: { status: { in: [...VISIBLE_MAPPING] } } }] },
      },
      take: MAX_PLANS + 1,
      select: { id: true, code: true, currency: true, occupancy: true, inventoryPoolId: true, status: true, roomType: { select: { maxOccupancy: true } }, contract: { select: { validFrom: true, validTo: true } } },
    })
    if (plans.length > MAX_PLANS) throw new BadRequestException('This hotel has too many rate plans to validate in one file; contact support.')
    const importPlans: ImportPlan[] = plans.map((plan) => ({
      id: plan.id, code: plan.code, currency: plan.currency, occupancy: plan.occupancy, maxOccupancy: plan.roomType.maxOccupancy, inventoryPoolId: plan.inventoryPoolId,
      expired: plan.status === 'EXPIRED', contractValidFrom: day(plan.contract.validFrom), contractValidTo: day(plan.contract.validTo),
    }))
    const refs = scanReferences(csv)
    const referenced = importPlans.filter((plan) => refs.planKeys.includes(plan.id) || refs.planKeys.includes(plan.code)).map((plan) => plan.id)
    const stayDates = refs.dates.map((d) => new Date(`${d}T00:00:00.000Z`))
    const rows = referenced.length && stayDates.length
      ? await tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId: { in: referenced }, stayDate: { in: stayDates } }, select: { ratePlanId: true, stayDate: true, allotment: true, sold: true, held: true, stopSell: true, minStay: true, releaseDays: true, updatedAt: true } })
      : []
    const availability = new Map<string, ExistingAvailability>(rows.map((row) => [`${row.ratePlanId}|${day(row.stayDate)}`, { updatedAt: row.updatedAt.toISOString(), allotment: row.allotment, sold: row.sold, held: row.held, stopSell: row.stopSell, minStay: row.minStay, releaseDays: row.releaseDays }]))
    return validateSupplierCsv(csv, importPlans, availability)
  }

  /** The error envelope carries `details`: every file-level and row-level issue, fatal first. */
  private issues(report: SupplierCsvReport) {
    return [...report.fatal, ...report.errors]
  }

  private previewOf(report: SupplierCsvReport): ExtranetChangeSetPreview {
    return { ok: report.ok, fatal: report.fatal, errors: report.errors, warnings: report.warnings, truncatedErrors: report.truncatedErrors, cells: report.cells.map(({ expectedUpdatedAt: _version, ...cell }) => cell) }
  }

  private summary(row: { id: string; hotelId: string; status: ExtranetChangeSetStatus; version: number; cellCount: number; createdAt: Date; submittedAt: Date | null; hotel: { name: string } | null }): ExtranetChangeSetSummary {
    return { id: row.id, hotelId: row.hotelId, hotelName: row.hotel?.name ?? null, status: row.status, version: row.version, cellCount: row.cellCount, createdAt: row.createdAt.toISOString(), submittedAt: row.submittedAt?.toISOString() ?? null }
  }

  private async load(tx: Prisma.TransactionClient, tenantId: string, supplierId: string, changeSetId: string): Promise<ExtranetChangeSetDetail> {
    const row = await tx.supplierChangeSet.findFirst({
      where: { id: changeSetId, tenantId, supplierId },
      select: {
        id: true, hotelId: true, status: true, version: true, cellCount: true, contentSha256: true, createdAt: true, submittedAt: true, hotel: { select: { name: true } },
        cells: { orderBy: [{ stayDate: 'asc' }, { ratePlanId: 'asc' }], select: { ratePlanId: true, stayDate: true, allotment: true, stopSell: true, minStay: true, releaseDays: true, ratePlan: { select: { code: true } } } },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { action: true, fromStatus: true, toStatus: true, createdAt: true } },
      },
    })
    if (!row) throw new NotFoundException({ message: 'Change set not found', code: 'CHANGE_SET_NOT_FOUND' })
    return {
      ...this.summary(row),
      contentSha256: row.contentSha256.trim(),
      cells: row.cells.map((cell) => ({ ratePlanId: cell.ratePlanId, ratePlanCode: cell.ratePlan.code, stayDate: day(cell.stayDate), allotment: cell.allotment, stopSell: cell.stopSell, minStay: cell.minStay, releaseDays: cell.releaseDays })),
      events: row.events.map((event) => ({ action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus, createdAt: event.createdAt.toISOString() })),
    }
  }
}
