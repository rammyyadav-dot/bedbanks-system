import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { IngestAllotment, IngestCancellationPolicy, IngestRate, IngestReject, IngestResult, IngestStatus } from '@bedbanks/connectors-core'

/**
 * Persistence of normalized supplier ingestion results (ADR 0078).
 *
 * Writes OBSERVATIONS keyed by supplier codes, never DailyRate / DailyAvailability / CancellationPolicy. Runs inside a caller-owned
 * tenant transaction (`PrismaService.withTenant`), so the run, its observations and its audit event commit or fail together.
 * Only a COMPLETE result applies observations; PARTIAL and FAILED results are recorded as evidence and change nothing
 * (the connector ingest core says callers must not replace inventory from them). Tenant, supplier and connector come from the
 * authenticated server context of the caller, never from the feed.
 */
export type IngestPersistenceCode = 'IDEMPOTENCY_CONFLICT' | 'CONNECTOR_NOT_ACTIVE' | 'INVALID_INPUT'
export class IngestPersistenceError extends Error {
  constructor(readonly code: IngestPersistenceCode) { super(`Ingest persistence refused (${code})`); this.name = 'IngestPersistenceError' }
}

export interface PersistScope {
  tenantId: string
  supplierId: string
  connectorId: string
  /** Stable across retries of the same delivery: 8-128 of [A-Za-z0-9_-]. */
  idempotencyKey: string
  /** The authenticated operator. A system actor needs its own audit policy and role, which this change does not add. */
  actorUserId: string
  receivedAt: Date
  /** Supplier-stated feed time, or null. */
  sourceUpdatedAt: Date | null
  /** Observations written by this call expire here (ADR 0030 #7). */
  freshUntil: Date
}

export interface PersistOutcome {
  runId: string
  status: IngestStatus
  applied: boolean
  /** True when the idempotency key had already been recorded with an identical result; nothing was written. */
  replayed: boolean
  /** Observation rows inserted or refreshed. */
  written: number
  /** Accepted rows not written because the stored row came from a newer feed. */
  superseded: number
}

type Kind = 'RATES' | 'ALLOTMENTS' | 'CANCELLATION_POLICIES'
const CHUNK = 1000
const KEY = /^[A-Za-z0-9_-]{8,128}$/
const SUMMARY_LIMIT = 100

/** Counts of `<code>:<field>`; no row content. Overflow is collapsed into one `other` bucket. */
export function summarizeRejects(rejected: readonly IngestReject[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rejected) {
    const key = `${r.code}:${r.field ?? '-'}`
    const bucket = key in out || Object.keys(out).length < SUMMARY_LIMIT ? key : 'other'
    out[bucket] = (out[bucket] ?? 0) + 1
  }
  return out
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** SHA-256 over the normalized result, independent of row order. The same delivery always hashes the same. */
export function hashResult(kind: Kind, result: IngestResult<unknown>): string {
  const rows = result.accepted.map(stable).sort()
  return createHash('sha256').update(stable({ kind, status: result.status, extracted: result.extracted, rows, rejected: result.rejected })).digest('hex')
}

function validate(scope: PersistScope): void {
  const ok = !!scope.tenantId && !!scope.supplierId && !!scope.connectorId && !!scope.actorUserId && KEY.test(scope.idempotencyKey) &&
    Number.isFinite(scope.receivedAt.getTime()) && Number.isFinite(scope.freshUntil.getTime()) && scope.freshUntil > scope.receivedAt &&
    (scope.sourceUpdatedAt === null || Number.isFinite(scope.sourceUpdatedAt.getTime()))
  if (!ok) throw new IngestPersistenceError('INVALID_INPUT')
}

async function persist<T>(
  tx: Prisma.TransactionClient, kind: Kind, scope: PersistScope, result: IngestResult<T>,
  write: (rows: readonly T[], runId: string) => Promise<number>,
): Promise<PersistOutcome> {
  validate(scope)
  const { tenantId, supplierId, connectorId, idempotencyKey } = scope
  const requestHash = hashResult(kind, result)

  // Serialize deliveries of one key so a concurrent retry observes the first one's run instead of failing on the unique index mid-transaction.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}|${connectorId}|${idempotencyKey}`}, 0))`

  const existing = await tx.supplierIngestRun.findFirst({ where: { tenantId, connectorId, idempotencyKey } })
  if (existing) {
    if (existing.requestHash !== requestHash || existing.kind !== kind) throw new IngestPersistenceError('IDEMPOTENCY_CONFLICT')
    return { runId: existing.id, status: existing.status, applied: existing.applied, replayed: true, written: 0, superseded: 0 }
  }

  const connector = await tx.connectorDefinition.findFirst({ where: { tenantId, id: connectorId, supplierId }, select: { status: true } })
  if (!connector || connector.status !== 'ACTIVE') throw new IngestPersistenceError('CONNECTOR_NOT_ACTIVE')

  const applied = result.status === 'COMPLETE'
  const run = await tx.supplierIngestRun.create({
    data: {
      tenantId, supplierId, connectorId, kind, idempotencyKey, requestHash, status: result.status,
      extractedCount: result.extracted, acceptedCount: result.accepted.length, rejectedCount: result.rejected.length,
      rejectSummary: summarizeRejects(result.rejected), applied,
      sourceUpdatedAt: scope.sourceUpdatedAt, receivedAt: scope.receivedAt, freshUntil: applied ? scope.freshUntil : null,
    },
    select: { id: true },
  })
  let written = 0
  if (applied) for (let i = 0; i < result.accepted.length; i += CHUNK) written += await write(result.accepted.slice(i, i + CHUNK), run.id)
  await tx.auditEvent.create({
    data: {
      tenantId, userId: scope.actorUserId, actorType: 'USER', action: `supplier.ingest.${result.status.toLowerCase()}`, entityType: 'supplier_ingest_run', entityId: run.id,
      payload: { kind, supplierId, connectorId, extracted: result.extracted, accepted: result.accepted.length, rejected: result.rejected.length, written, applied },
    },
  })
  return { runId: run.id, status: result.status, applied, replayed: false, written, superseded: applied ? result.accepted.length - written : 0 }
}

const col = <T,>(rows: readonly T[], f: (r: T) => unknown) => rows.map(f)

/**
 * Upserts keep the NEWER feed: the conflict update only fires when the stored row is not newer than this run's receipt time, so a delayed
 * older delivery cannot overwrite fresher data (the database trigger is the backstop). Every statement names the tenant.
 */
export function persistRates(tx: Prisma.TransactionClient, scope: PersistScope, result: IngestResult<IngestRate>): Promise<PersistOutcome> {
  return persist(tx, 'RATES', scope, result, async (rows, runId) => {
    return tx.$executeRaw`
      INSERT INTO "SupplierRateObservation" ("id","tenant_id","supplier_id","run_id","supplier_hotel_code","supplier_room_code","supplier_rate_plan_code","stay_date","board_code","currency","net_minor","taxes_included","min_stay","max_stay","closed_to_arrival","closed_to_departure","received_at","fresh_until","updated_at")
      SELECT gen_random_uuid()::text, ${scope.tenantId}, ${scope.supplierId}, ${runId}, t.hotel, t.room, t.plan, t.stay_date, t.board, t.currency, t.net_minor, t.taxes, t.min_stay, t.max_stay, t.cta, t.ctd, ${scope.receivedAt}, ${scope.freshUntil}, now()
      FROM unnest(${col(rows, (r) => r.supplierHotelCode)}::text[], ${col(rows, (r) => r.supplierRoomCode)}::text[], ${col(rows, (r) => r.supplierRatePlanCode)}::text[], ${col(rows, (r) => r.stayDate)}::date[], ${col(rows, (r) => r.boardCode)}::text[], ${col(rows, (r) => r.currency)}::text[], ${col(rows, (r) => String(r.netMinor))}::bigint[], ${col(rows, (r) => r.taxesIncluded)}::boolean[], ${col(rows, (r) => r.minStay)}::int[], ${col(rows, (r) => r.maxStay)}::int[], ${col(rows, (r) => r.closedToArrival)}::boolean[], ${col(rows, (r) => r.closedToDeparture)}::boolean[])
        AS t(hotel, room, plan, stay_date, board, currency, net_minor, taxes, min_stay, max_stay, cta, ctd)
      ON CONFLICT ("tenant_id","supplier_id","supplier_hotel_code","supplier_room_code","supplier_rate_plan_code","stay_date") DO UPDATE SET
        "run_id" = EXCLUDED."run_id", "board_code" = EXCLUDED."board_code", "currency" = EXCLUDED."currency", "net_minor" = EXCLUDED."net_minor", "taxes_included" = EXCLUDED."taxes_included",
        "min_stay" = EXCLUDED."min_stay", "max_stay" = EXCLUDED."max_stay", "closed_to_arrival" = EXCLUDED."closed_to_arrival", "closed_to_departure" = EXCLUDED."closed_to_departure",
        "received_at" = EXCLUDED."received_at", "fresh_until" = EXCLUDED."fresh_until", "updated_at" = now()
      WHERE "SupplierRateObservation"."tenant_id" = ${scope.tenantId} AND "SupplierRateObservation"."received_at" <= EXCLUDED."received_at"`
  })
}

export function persistAllotments(tx: Prisma.TransactionClient, scope: PersistScope, result: IngestResult<IngestAllotment>): Promise<PersistOutcome> {
  return persist(tx, 'ALLOTMENTS', scope, result, async (rows, runId) => {
    return tx.$executeRaw`
      INSERT INTO "SupplierAllotmentObservation" ("id","tenant_id","supplier_id","run_id","supplier_hotel_code","supplier_room_code","supplier_rate_plan_code","stay_date","mode","available","stop_sell","release_days","received_at","fresh_until","updated_at")
      SELECT gen_random_uuid()::text, ${scope.tenantId}, ${scope.supplierId}, ${runId}, t.hotel, t.room, t.plan, t.stay_date, t.mode::"InventoryMode", t.available, t.stop_sell, t.release_days, ${scope.receivedAt}, ${scope.freshUntil}, now()
      FROM unnest(${col(rows, (r) => r.supplierHotelCode)}::text[], ${col(rows, (r) => r.supplierRoomCode)}::text[], ${col(rows, (r) => r.supplierRatePlanCode ?? '')}::text[], ${col(rows, (r) => r.stayDate)}::date[], ${col(rows, (r) => r.mode)}::text[], ${col(rows, (r) => r.available)}::int[], ${col(rows, (r) => r.stopSell)}::boolean[], ${col(rows, (r) => r.releaseDays)}::int[])
        AS t(hotel, room, plan, stay_date, mode, available, stop_sell, release_days)
      ON CONFLICT ("tenant_id","supplier_id","supplier_hotel_code","supplier_room_code","supplier_rate_plan_code","stay_date") DO UPDATE SET
        "run_id" = EXCLUDED."run_id", "mode" = EXCLUDED."mode", "available" = EXCLUDED."available", "stop_sell" = EXCLUDED."stop_sell", "release_days" = EXCLUDED."release_days",
        "received_at" = EXCLUDED."received_at", "fresh_until" = EXCLUDED."fresh_until", "updated_at" = now()
      WHERE "SupplierAllotmentObservation"."tenant_id" = ${scope.tenantId} AND "SupplierAllotmentObservation"."received_at" <= EXCLUDED."received_at"`
  })
}

export function persistCancellationPolicies(tx: Prisma.TransactionClient, scope: PersistScope, result: IngestResult<IngestCancellationPolicy>): Promise<PersistOutcome> {
  return persist(tx, 'CANCELLATION_POLICIES', scope, result, async (rows, runId) => {
    return tx.$executeRaw`
      INSERT INTO "SupplierCancellationObservation" ("id","tenant_id","supplier_id","run_id","supplier_hotel_code","supplier_room_code","supplier_rate_plan_code","non_refundable","windows","received_at","fresh_until","updated_at")
      SELECT gen_random_uuid()::text, ${scope.tenantId}, ${scope.supplierId}, ${runId}, t.hotel, t.room, t.plan, t.non_refundable, t.windows::jsonb, ${scope.receivedAt}, ${scope.freshUntil}, now()
      FROM unnest(${col(rows, (r) => r.supplierHotelCode)}::text[], ${col(rows, (r) => r.supplierRoomCode ?? '')}::text[], ${col(rows, (r) => r.supplierRatePlanCode)}::text[], ${col(rows, (r) => r.nonRefundable)}::boolean[], ${col(rows, (r) => JSON.stringify(r.windows))}::text[])
        AS t(hotel, room, plan, non_refundable, windows)
      ON CONFLICT ("tenant_id","supplier_id","supplier_hotel_code","supplier_room_code","supplier_rate_plan_code") DO UPDATE SET
        "run_id" = EXCLUDED."run_id", "non_refundable" = EXCLUDED."non_refundable", "windows" = EXCLUDED."windows",
        "received_at" = EXCLUDED."received_at", "fresh_until" = EXCLUDED."fresh_until", "updated_at" = now()
      WHERE "SupplierCancellationObservation"."tenant_id" = ${scope.tenantId} AND "SupplierCancellationObservation"."received_at" <= EXCLUDED."received_at"`
  })
}
