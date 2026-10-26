import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { BookingFinancePostingDatabase } from '../booking-finance-posting/booking-finance-posting.database'
import { createCommissionPayoutRow } from './commission-payout-core'
import { commissionGrossBookedVolume } from './commission-volume'

const MIN_INTERVAL_MS = 60_000
const DEFAULT_INTERVAL_MS = 21_600_000 // 6h: proposing is a once-a-month event per agency, nothing is lost by polling slowly

type Env = Record<string, string | undefined>

export interface CommissionSchedulerRuntime {
  listActiveTenantIds(): Promise<string[]>
  /** Proposes whatever is due for one tenant and returns how many payouts it proposed. */
  proposeDue(tenantId: string, now: Date): Promise<number>
  close(): Promise<void>
  verify?(): Promise<void>
}

/** The closed calendar month immediately before `now`, as `[periodStart, periodEnd)` half-open UTC dates. */
export function priorCalendarMonth(now: Date): { periodStart: string; periodEnd: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { periodStart: iso(start), periodEnd: iso(end) }
}

/**
 * Proposes last month's agency commission payouts automatically (ADR 0098 update), landing each in the same PROPOSED
 * state a human proposal would — a formal finance user must still approve or reject it; the scheduler never approves
 * its own work. It needs no scheduling library: the repository's other background jobs (ADR 0005, ADR 0057) are a plain
 * `setInterval` over active tenants, and this follows the same shape.
 *
 * Proposing a payout writes an `actorType: 'SYSTEM'` audit event, which no tenant-scoped role may do under the ordinary
 * `AuditEvent_tenant_insert` policy (ADR 0005's `fbeds_hold_expiry` precedent). This scheduler therefore runs on its own
 * narrow database role (`COMMISSION_SCHEDULER_DATABASE_URL`, group role `fbeds_commission_scheduler`), never on the HTTP
 * role's connection, and is off unless both the feature flag and that credential are set. See
 * `docs/adr/0098-agency-commission-payout.md` and the migration that grants the role's one audit exception.
 *
 * Picking a currency: an agency may hold wallets in more than one currency, but a period may be paid at most once
 * (`AgencyCommissionPayout` is unique on agency + period). The scheduler proposes the agency's single highest-volume
 * currency for the month and leaves any other currency for a human to propose by hand through the ordinary endpoint —
 * recorded as a deliberate limitation, not silently working around the per-period uniqueness the table enforces.
 */
@Injectable()
export class CommissionPayoutScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommissionPayoutScheduler.name)
  private runtime?: CommissionSchedulerRuntime
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    @Optional() private readonly postings?: BookingFinancePostingDatabase,
    @Optional() private readonly env: Env = process.env,
    @Optional() runtime?: CommissionSchedulerRuntime,
  ) {
    this.runtime = runtime
  }

  async onModuleInit(): Promise<void> {
    if (this.env.COMMISSION_PAYOUT_SCHEDULER_ENABLED !== 'true') return
    if (!this.runtime) {
      const url = this.env.COMMISSION_SCHEDULER_DATABASE_URL
      if (!url) throw new Error('COMMISSION_PAYOUT_SCHEDULER_ENABLED requires COMMISSION_SCHEDULER_DATABASE_URL')
      if (url === this.env.DATABASE_URL) throw new Error('COMMISSION_SCHEDULER_DATABASE_URL must be a different credential from the HTTP DATABASE_URL')
      if (!this.postings) throw new Error('COMMISSION_PAYOUT_SCHEDULER_ENABLED requires the booking finance posting module to be loaded')
      this.runtime = defaultRuntime(url, this.postings)
    }
    try { await this.runtime.verify?.() } catch (error) { await this.runtime.close().catch(() => undefined); this.runtime = undefined; throw error }
    const interval = Number(this.env.COMMISSION_PAYOUT_SCHEDULER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`COMMISSION_PAYOUT_SCHEDULER_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Commission payout scheduler enabled every ${interval}ms`)
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.runtime?.close()
    this.runtime = undefined
  }

  /** One pass over active tenants; never overlaps itself. A failing tenant is logged and does not stop the others. Returns payouts proposed. */
  async runOnce(now: Date = new Date()): Promise<number> {
    const runtime = this.runtime
    if (!runtime || this.running) return 0
    this.running = true
    let proposed = 0; let failedTenants = 0
    try {
      for (const tenantId of await runtime.listActiveTenantIds()) {
        try { proposed += await runtime.proposeDue(tenantId, now) } catch (error) {
          failedTenants += 1
          this.logger.error(`Commission payout scheduling failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Commission payout scheduler could not list tenants: ${error instanceof Error ? error.name : 'unknown error'}`)
      return proposed
    } finally { this.running = false }
    if (proposed > 0 || failedTenants > 0) this.logger.log(`Commission payout scheduling pass: proposed=${proposed} failedTenants=${failedTenants}`)
    return proposed
  }
}

/** Proposes the prior calendar month for every ACTIVE agency of one tenant that does not already have a payout for it, picking each agency's highest-volume currency. */
export async function proposeDueInTenant(
  scheduler: PrismaService,
  postings: BookingFinancePostingDatabase,
  tenantId: string,
  now: Date,
): Promise<number> {
  const { periodStart, periodEnd } = priorCalendarMonth(now)
  let proposed = 0
  await scheduler.withTenant(tenantId, async (tx: Prisma.TransactionClient) => {
    const agencies = await tx.agency.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true } })
    for (const agency of agencies) {
      const existing = await tx.agencyCommissionPayout.findFirst({ where: { tenantId, agencyId: agency.id, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) } })
      if (existing) continue
      const wallets = await tx.wallet.findMany({ where: { tenantId, agencyId: agency.id }, select: { currency: true }, distinct: ['currency'] })
      let bestCurrency: string | null = null
      let bestVolume = 0n
      for (const w of wallets) {
        const volume = await commissionGrossBookedVolume(tx, postings, tenantId, agency.id, w.currency, periodStart, periodEnd)
        if (volume > bestVolume) { bestVolume = volume; bestCurrency = w.currency }
      }
      if (!bestCurrency || bestVolume <= 0n) continue
      const requestId = `scheduler:${agency.id}:${periodStart}`
      await createCommissionPayoutRow(tx, { tenantId, agencyId: agency.id, periodStart, periodEnd, currency: bestCurrency, requestId, grossBookedMinor: bestVolume, actor: { kind: 'SYSTEM' } })
      proposed += 1
    }
  })
  return proposed
}

function defaultRuntime(databaseUrl: string, postings: BookingFinancePostingDatabase): CommissionSchedulerRuntime {
  const prisma = new PrismaService({ datasourceUrl: databaseUrl })
  return {
    listActiveTenantIds: async () => (await prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map((tenant) => tenant.id),
    proposeDue: (tenantId, now) => proposeDueInTenant(prisma, postings, tenantId, now),
    close: () => prisma.$disconnect(),
    verify: () => prisma.assertRestrictedRuntimeRole('Commission payout scheduler'),
  }
}
