import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { defaultSettlementCurrency, enabledSettlementCurrencies } from '../agent/currency'
import { createHash } from 'node:crypto'
import type { TenantSettingsView } from '@bedbanks/contracts'
import {
  TENANT_SETTING_CURRENCIES,
  TENANT_SETTING_LANGUAGES,
  TENANT_SETTING_TIME_ZONES,
} from '@bedbanks/contracts'
import type { Prisma } from '@prisma/client'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { TenantControlDatabase } from '../platform-admin/tenant-control.database'
import { sessionTenantId } from '../agent/tenant-context.guard'
import type { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/

type SettingsRow = {
  id: string
  supportEmail: string | null
  defaultLanguage: string
  timeZone: string
  defaultCurrency: string
  lowBalanceThresholdMinor: bigint
  lowBalanceCurrency: string
  lastIdempotencyKey: string | null
  lastMutationFingerprint: string | null
  updatedAt: Date
  tenant: { id: string; name: string; slug: string; status: string }
}

@Injectable()
export class AdminSettingsService {
  constructor(private readonly controlDb: TenantControlDatabase) {}

  async getSettings(identity: AuthenticatedUser, selectedTenantId?: string): Promise<TenantSettingsView> {
    const tenantId = sessionTenantId(identity, selectedTenantId)
    return this.controlDb.withTenant(tenantId, async (tx) => this.toView(await this.ensureRow(tx, tenantId)))
  }

  async updateSettings(identity: AuthenticatedUser, body: UpdateTenantSettingsDto, idempotencyKey: string | undefined, requestId: string | undefined, selectedTenantId?: string): Promise<TenantSettingsView> {
    const tenantId = sessionTenantId(identity, selectedTenantId)
    const key = idempotencyKey?.trim() ?? ''
    if (!IDEMPOTENCY_KEY.test(key)) throw new BadRequestException('Idempotency-Key is required')

    const name = body.name.trim()
    if (!name) throw new BadRequestException('Workspace name is required')
    const supportEmail = this.normalizeEmail(body.supportEmail)
    const defaultLanguage = body.defaultLanguage
    const timeZone = body.timeZone
    const defaultCurrency = body.defaultCurrency.toUpperCase()
    const lowBalanceCurrency = body.lowBalanceThreshold.currency.toUpperCase()
    this.assertLanguage(defaultLanguage)
    this.assertTimeZone(timeZone)
    this.assertCurrency(defaultCurrency)
    this.assertCurrency(lowBalanceCurrency)
    if (!/^\d+$/.test(body.lowBalanceThreshold.amountMinor)) throw new BadRequestException('Low-balance threshold must be a non-negative integer string')
    const lowBalanceThresholdMinor = BigInt(body.lowBalanceThreshold.amountMinor)

    if (lowBalanceThresholdMinor > 9223372036854775807n) throw new BadRequestException('Low-balance threshold exceeds the supported range')

    const fingerprint = createHash('sha256').update(JSON.stringify({
      name, supportEmail, defaultLanguage, timeZone, defaultCurrency, lowBalanceThresholdMinor: lowBalanceThresholdMinor.toString(), lowBalanceCurrency,
    })).digest('hex')

    return this.controlDb.withTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`
      const current = await this.ensureRow(tx, tenantId)
      const previous = await tx.auditEvent.findFirst({ where: { tenantId, action: 'settings.updated', payload: { path: ['idempotencyKey'], equals: key } } })
      if (previous) {
        if ((previous.payload as Prisma.JsonObject).fingerprint !== fingerprint) throw new ConflictException('Idempotency key was reused with different settings')
        return this.toView(current)
      }
      if (current.lastIdempotencyKey === key) {
        if (current.lastMutationFingerprint === fingerprint) return this.toView(current)
        throw new ConflictException('Idempotency key was reused with different settings')
      }

      const before = this.snapshot(current)
      const tenant = await tx.tenant.update({ where: { id: tenantId }, data: { name } })
      const updated = await tx.tenantSettings.update({
        where: { tenantId },
        data: {
          supportEmail,
          defaultLanguage,
          timeZone,
          defaultCurrency,
          lowBalanceThresholdMinor,
          lowBalanceCurrency,
          lastIdempotencyKey: key,
          lastMutationFingerprint: fingerprint,
        },
        include: { tenant: true },
      })
      const after = this.snapshot({ ...updated, tenant })
      await tx.auditEvent.create({
        data: {
          tenantId,
          userId: identity.user.id,
          actorType: 'USER',
          action: 'settings.updated',
          entityType: 'tenant_settings',
          entityId: updated.id,
          payload: { outcome: 'allowed', idempotencyKey: key, fingerprint, requestId: requestId ?? null, before, after },
        },
      })
      return this.toView({ ...updated, tenant })
    })
  }

  private async ensureRow(tx: Prisma.TransactionClient, tenantId: string): Promise<SettingsRow> {
    // ON CONFLICT DO NOTHING keeps concurrent first reads from aborting the transaction.
    await tx.tenantSettings.createMany({ data: [{ tenantId, defaultCurrency: defaultSettlementCurrency(), lowBalanceCurrency: defaultSettlementCurrency() }], skipDuplicates: true })
    return tx.tenantSettings.findUniqueOrThrow({ where: { tenantId }, include: { tenant: true } })
  }

  private toView(row: SettingsRow): TenantSettingsView {
    return {
      tenantId: row.tenant.id,
      name: row.tenant.name,
      slug: row.tenant.slug,
      status: row.tenant.status,
      supportEmail: row.supportEmail,
      defaultLanguage: row.defaultLanguage as TenantSettingsView['defaultLanguage'],
      timeZone: row.timeZone as TenantSettingsView['timeZone'],
      defaultCurrency: row.defaultCurrency.trim() as TenantSettingsView['defaultCurrency'],
      lowBalanceThreshold: {
        amountMinor: row.lowBalanceThresholdMinor.toString(),
        currency: row.lowBalanceCurrency.trim(),
      },
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private snapshot(row: Pick<SettingsRow, 'supportEmail' | 'defaultLanguage' | 'timeZone' | 'defaultCurrency' | 'lowBalanceThresholdMinor' | 'lowBalanceCurrency'> & { tenant: { name: string } }) {
    return {
      name: row.tenant.name,
      supportEmail: row.supportEmail,
      defaultLanguage: row.defaultLanguage,
      timeZone: row.timeZone,
      defaultCurrency: row.defaultCurrency.trim(),
      lowBalanceThreshold: { amountMinor: row.lowBalanceThresholdMinor.toString(), currency: row.lowBalanceCurrency.trim() },
    }
  }

  private normalizeEmail(value: string | null | undefined): string | null {
    if (value == null) return null
    const trimmed = value.trim()
    return trimmed.length === 0 ? null : trimmed
  }

  private assertLanguage(value: string): void {
    if (!(TENANT_SETTING_LANGUAGES as readonly string[]).includes(value)) throw new BadRequestException('Unsupported language')
  }

  private assertTimeZone(value: string): void {
    if (!(TENANT_SETTING_TIME_ZONES as readonly string[]).includes(value)) throw new BadRequestException('Unsupported time zone')
  }

  private assertCurrency(value: string): void {
    if (!(TENANT_SETTING_CURRENCIES as readonly string[]).includes(value) || !(enabledSettlementCurrencies() as readonly string[]).includes(value)) throw new BadRequestException('Unsupported currency')
  }
}
