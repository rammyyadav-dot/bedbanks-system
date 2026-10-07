import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { InventoryHoldService } from './inventory-hold.service'

export const HOLD_EXPIRY_BATCH_SIZE = 100
const MIN_INTERVAL_MS = 5_000
const DEFAULT_INTERVAL_MS = 60_000

export interface HoldExpiryRuntime {
  listActiveTenantIds(): Promise<string[]>
  expireDue(tenantId: string): Promise<number>
  close(): Promise<void>
  /** Optional identity check run once at startup (P0-01). */
  verify?(): Promise<void>
}

type Env = Record<string, string | undefined>

/**
 * Releases inventory held by expired InventoryHold rows.
 *
 * Expiry writes SYSTEM audit events, which the ordinary HTTP database role
 * cannot do, so the sweeper only runs when explicitly enabled AND given its own
 * credential (HOLD_EXPIRY_DATABASE_URL) for the governed restricted background
 * role. It is disabled by default. See docs/adr/0005-hold-expiry-sweeper.md.
 */
@Injectable()
export class HoldExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HoldExpirySweeper.name)
  private runtime?: HoldExpiryRuntime
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly env: Env = process.env,
    private readonly createRuntime: (databaseUrl: string) => HoldExpiryRuntime = defaultRuntime,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.HOLD_EXPIRY_SWEEP_ENABLED !== 'true') return
    const url = this.env.HOLD_EXPIRY_DATABASE_URL
    if (!url) throw new Error('HOLD_EXPIRY_SWEEP_ENABLED requires HOLD_EXPIRY_DATABASE_URL')
    if (url === this.env.DATABASE_URL) throw new Error('HOLD_EXPIRY_DATABASE_URL must be a different credential from the HTTP DATABASE_URL')
    const interval = Number(this.env.HOLD_EXPIRY_SWEEP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`HOLD_EXPIRY_SWEEP_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.runtime = this.createRuntime(url)
    try { await this.runtime.verify?.() } catch (error) { await this.runtime.close().catch(() => undefined); this.runtime = undefined; throw error } // P0-01: a privileged sweeper credential stops startup
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Hold expiry sweeper enabled every ${interval}ms`)
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.runtime?.close()
    this.runtime = undefined
  }

  /** One pass over active tenants. Returns holds expired; never overlaps itself. */
  async runOnce(): Promise<number> {
    const runtime = this.runtime
    if (!runtime || this.running) return 0
    this.running = true
    let expired = 0
    let failedTenants = 0
    try {
      for (const tenantId of await runtime.listActiveTenantIds()) {
        try {
          let count: number
          do {
            count = await runtime.expireDue(tenantId)
            expired += count
          } while (count >= HOLD_EXPIRY_BATCH_SIZE)
        } catch (error) {
          failedTenants += 1
          this.logger.error(`Hold expiry failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Hold expiry could not list tenants: ${error instanceof Error ? error.name : 'unknown error'}`)
      return expired
    } finally {
      this.running = false
    }
    if (expired > 0 || failedTenants > 0) this.logger.log(`Hold expiry pass: expired=${expired} failedTenants=${failedTenants}`)
    return expired
  }
}

function defaultRuntime(databaseUrl: string): HoldExpiryRuntime {
  const prisma = new PrismaService({ datasourceUrl: databaseUrl })
  const holds = new InventoryHoldService(prisma)
  return {
    listActiveTenantIds: async () => (await prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map(tenant => tenant.id),
    expireDue: tenantId => holds.expireDue(tenantId),
    close: () => prisma.$disconnect(),
    verify: () => prisma.assertRestrictedRuntimeRole('Hold expiry sweeper'),
  }
}
