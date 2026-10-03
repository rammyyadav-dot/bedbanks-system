import { createHash } from 'crypto'
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  QUICK_UPDATE_LIMITS, QUICK_UPDATE_UNSUPPORTED,
  type QuickUpdateApplied, type QuickUpdateApply, type QuickUpdatePlanRef, type QuickUpdatePreview, type QuickUpdateRequest,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { idParam } from '../admin-operations/query-params'
import { dayInZone, normaliseQuickUpdate, planQuickUpdate, type AvailState, type NormalisedQuickUpdate, type PlanInfo, type PlannedRow, type RateState } from './quick-update-rules'

type Tx = Prisma.TransactionClient
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
const APPLIED = 'hotel.quick_update.applied'
const day = (d: Date) => d.toISOString().slice(0, 10)
const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`)

interface Loaded {
  hotel: { id: string; timeZone: string }
  plans: Map<string, PlanInfo>
  refs: Map<string, QuickUpdatePlanRef>
  rates: Map<string, RateState>
  avail: Map<string, AvailState>
  fingerprint: string
}

/**
 * Quick Update (ADR 0021, stage 5): preview, then atomically apply, a change to rates, availability and per-night restrictions
 * for one hotel. Tenant comes from the session and every plan must belong to the hotel. Apply never trusts a preview: it takes a
 * per-hotel advisory lock, re-reads the current rows, re-runs the same validation and compares the fingerprint of what it read with
 * the one the operator reviewed. Money stays integer minor units; nothing is written unless every record is valid.
 */
@Injectable()
export class HotelQuickUpdateService {
  /** Replaceable in tests. */
  clock: () => Date = () => new Date()
  constructor(private readonly prisma: PrismaService) {}

  /** The manage permissions a request needs: price needs rates, availability and restrictions need availability. */
  required(value: NormalisedQuickUpdate): Array<'supply.rates.manage' | 'supply.availability.manage'> {
    const out: Array<'supply.rates.manage' | 'supply.availability.manage'> = []
    if (value.changes.price) out.push('supply.rates.manage')
    if (value.changes.availability || value.changes.restrictions) out.push('supply.availability.manage')
    return out
  }

  private async requirePermissions(tenantId: string, userId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({ where: { userId, tenantId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    const held = new Set(roles.flatMap((a) => a.role.permissions.map((p) => p.permission.key)))
    const missing = keys.filter((k) => !held.has(k))
    if (missing.length) throw new ForbiddenException(`Insufficient permission: ${missing.join(', ')}`)
  }

  private async load(tx: Tx, tenantId: string, hotelIdRaw: string, value: NormalisedQuickUpdate): Promise<Loaded & { dates: string[] }> {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true, timeZone: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    const found = await tx.ratePlan.findMany({
      where: { id: { in: value.ratePlanIds }, tenantId, roomType: { hotelId: hotel.id } },
      include: { roomType: { select: { name: true } }, boardBasis: { select: { code: true } }, contract: { select: { code: true, validFrom: true, validTo: true, supplier: { select: { displayName: true } } } } },
    })
    const plans = new Map<string, PlanInfo>(); const refs = new Map<string, QuickUpdatePlanRef>()
    for (const p of found) {
      plans.set(p.id, { id: p.id, status: p.status, currency: p.currency, occupancy: p.occupancy, contractFrom: day(p.contract.validFrom), contractTo: day(p.contract.validTo) })
      refs.set(p.id, { id: p.id, code: p.code, roomName: p.roomType.name, boardCode: p.boardBasis.code.trim(), contractCode: p.contract.code, supplierName: p.contract.supplier.displayName, currency: p.currency, occupancy: p.occupancy, status: p.status })
    }
    const dates = [...new Set(value.ranges.flatMap((r) => [r.from, r.to]))].sort()
    const gte = toDate(dates[0]); const lte = toDate(dates[dates.length - 1])
    const planIds = [...plans.keys()]
    const [rateRows, availRows] = planIds.length === 0 ? [[], []] : await Promise.all([
      tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte, lte } } }),
      tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte, lte } } }),
    ])
    const rates = new Map<string, RateState>(); const avail = new Map<string, AvailState>(); const lines: string[] = []
    for (const p of found) lines.push(`P|${p.id}|${p.status}|${p.currency}|${p.occupancy}|${day(p.contract.validFrom)}|${day(p.contract.validTo)}`)
    for (const r of rateRows) {
      if (r.occupancy !== plans.get(r.ratePlanId)!.occupancy) continue
      rates.set(`${r.ratePlanId}:${day(r.stayDate)}`, { amountMinor: r.amountMinor, basis: r.amountBasis === 'NET' || r.amountBasis === 'SELL' ? r.amountBasis : null })
      lines.push(`R|${r.ratePlanId}|${day(r.stayDate)}|${r.amountMinor}|${r.amountBasis ?? ''}|${r.updatedAt.getTime()}`)
    }
    for (const a of availRows) {
      avail.set(`${a.ratePlanId}:${day(a.stayDate)}`, { allotment: a.allotment, sold: a.sold, held: a.held, stopSell: a.stopSell, minStay: a.minStay, closedToArrival: a.closedToArrival })
      lines.push(`A|${a.ratePlanId}|${day(a.stayDate)}|${a.allotment}|${a.sold}|${a.held}|${a.stopSell}|${a.minStay}|${a.closedToArrival}|${a.updatedAt.getTime()}`)
    }
    const fingerprint = createHash('sha256').update(lines.sort().join('\n')).digest('hex')
    return { hotel, plans, refs, rates, avail, fingerprint, dates: [] }
  }

  private plan(loaded: Loaded, value: NormalisedQuickUpdate) {
    return planQuickUpdate({ value, plans: loaded.plans, rates: loaded.rates, avail: loaded.avail, today: dayInZone(this.clock(), loaded.hotel.timeZone) })
  }

  async preview(tenantId: string, userId: string, hotelId: string, body: QuickUpdateRequest): Promise<QuickUpdatePreview> {
    const { value, errors } = normaliseQuickUpdate(body)
    if (!value) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    await this.requirePermissions(tenantId, userId, this.required(value))
    return this.prisma.withTenant(tenantId, async (tx) => {
      const loaded = await this.load(tx, tenantId, hotelId, value)
      const planned = this.plan(loaded, value)
      const shown = planned.rows.slice(0, QUICK_UPDATE_LIMITS.reportedRows)
      return {
        generatedAt: this.clock().toISOString(), fingerprint: loaded.fingerprint, hotelToday: dayInZone(this.clock(), loaded.hotel.timeZone), timeZone: loaded.hotel.timeZone,
        plans: value.ratePlanIds.map((id) => loaded.refs.get(id)).filter((p): p is QuickUpdatePlanRef => !!p), dates: planned.dates,
        counts: planned.counts,
        rows: shown.map(({ nextRate: _r, nextAvail: _a, ...row }) => row), truncated: planned.rows.length > shown.length,
        errors: planned.errors, unsupported: [...QUICK_UPDATE_UNSUPPORTED],
        canApply: planned.errors.length === 0 && planned.counts.invalid === 0 && planned.counts.willChange > 0,
      }
    })
  }

  async apply(tenantId: string, userId: string, hotelIdRaw: string, body: QuickUpdateApply, requestId: string | null): Promise<QuickUpdateApplied> {
    if (typeof body?.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    if (typeof body.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)) throw new BadRequestException('expectedFingerprint is required: preview the change first')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3 || reason.length > 500) throw new BadRequestException('A reason of 3 to 500 characters is required')
    const { value, errors } = normaliseQuickUpdate(body)
    if (!value) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    await this.requirePermissions(tenantId, userId, this.required(value))
    const hotelId = idParam('hotelId', hotelIdRaw)
    if (!hotelId) throw new BadRequestException('Invalid hotelId')
    return this.prisma.withTenant(tenantId, async (tx) => {
      // One apply per hotel at a time: the check and the write below must not interleave with another apply.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quick-update:${tenantId}:${hotelId}`}))`
      const prior = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: hotelId, action: APPLIED, payload: { path: ['idempotencyKey'], equals: body.idempotencyKey } }, select: { payload: true } })
      if (prior) {
        const p = prior.payload as { requestId?: string; records?: number; changed?: QuickUpdateApplied['changed']; fingerprintAfter?: string }
        return { replayed: true, auditRequestId: p.requestId ?? '', records: p.records ?? 0, changed: p.changed ?? { rates: 0, availabilityRows: 0 }, fingerprintAfter: p.fingerprintAfter ?? '' }
      }
      const loaded = await this.load(tx, tenantId, hotelId, value)
      const planned = this.plan(loaded, value)
      if (planned.errors.length) throw new UnprocessableEntityException({ message: planned.errors, code: 'QUICK_UPDATE_INVALID' })
      if (planned.counts.invalid > 0) {
        const first = planned.rows.filter((r) => r.outcome === 'INVALID').slice(0, 5).map((r) => `${r.date}: ${r.problems[0]}`)
        throw new UnprocessableEntityException({ message: [`${planned.counts.invalid} record(s) are invalid, so nothing was written.`, ...first], code: 'QUICK_UPDATE_INVALID' })
      }
      if (loaded.fingerprint !== body.expectedFingerprint) throw new ConflictException({ message: 'The rates or inventory changed after you previewed this update. Nothing was written. Preview again to see the current values.', code: 'QUICK_UPDATE_STALE' })
      if (planned.counts.willChange === 0) throw new ConflictException({ message: 'Nothing would change: every selected record already has these values.', code: 'QUICK_UPDATE_NO_CHANGE' })

      const writes = await this.write(tx, tenantId, loaded, planned.rows.filter((r) => r.outcome === 'CHANGE'))
      const after = await this.load(tx, tenantId, hotelId, value)
      const fields = [...new Set(planned.rows.flatMap((r) => r.changes.map((c) => c.field)))].sort()
      const sample = planned.rows.filter((r) => r.outcome === 'CHANGE').slice(0, 20).map((r) => ({ ratePlanId: r.ratePlanId, date: r.date, changes: r.changes }))
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: APPLIED, entityType: 'hotel', entityId: hotelId, payload: {
        outcome: 'allowed', requestId, idempotencyKey: body.idempotencyKey, reason, ratePlanIds: value.ratePlanIds, ranges: value.ranges, weekdays: value.weekdays, fields,
        records: planned.counts.records, changedRecords: planned.counts.willChange, changed: writes, fingerprintBefore: loaded.fingerprint, fingerprintAfter: after.fingerprint, sample,
      } as unknown as Prisma.InputJsonValue } })
      return { replayed: false, auditRequestId: requestId ?? '', records: planned.counts.records, changed: writes, fingerprintAfter: after.fingerprint }
    })
  }

  private async write(tx: Tx, tenantId: string, loaded: Loaded, rows: PlannedRow[]): Promise<{ rates: number; availabilityRows: number }> {
    let rates = 0; let availabilityRows = 0
    const newRates: Prisma.DailyRateCreateManyInput[] = []; const newAvail: Prisma.DailyAvailabilityCreateManyInput[] = []
    for (const row of rows) {
      const plan = loaded.plans.get(row.ratePlanId)!
      const stayDate = toDate(row.date)
      if (row.nextRate) {
        if (loaded.rates.has(`${row.ratePlanId}:${row.date}`)) await tx.dailyRate.update({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: row.ratePlanId, stayDate, occupancy: plan.occupancy } }, data: { amountMinor: row.nextRate.amountMinor, amountBasis: row.nextRate.basis, currency: plan.currency } })
        else newRates.push({ tenantId, ratePlanId: row.ratePlanId, stayDate, occupancy: plan.occupancy, amountMinor: row.nextRate.amountMinor, amountBasis: row.nextRate.basis, currency: plan.currency })
        rates++
      }
      if (row.nextAvail) {
        const n = row.nextAvail
        if (n.create) newAvail.push({ tenantId, ratePlanId: row.ratePlanId, stayDate, allotment: n.allotment, sold: 0, held: 0, stopSell: n.stopSell, minStay: n.minStay, closedToArrival: n.closedToArrival })
        else await tx.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: row.ratePlanId, stayDate } }, data: { allotment: n.allotment, stopSell: n.stopSell, minStay: n.minStay, closedToArrival: n.closedToArrival } })
        availabilityRows++
      }
    }
    if (newRates.length) await tx.dailyRate.createMany({ data: newRates })
    if (newAvail.length) await tx.dailyAvailability.createMany({ data: newAvail })
    return { rates, availabilityRows }
  }
}
