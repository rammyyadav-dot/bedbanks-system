import { ConflictException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { Prisma } from '@prisma/client'
import { isDatabasePermissionDenied } from '../database/db-errors'
import { assertRuntimeDbIdentity } from '../database/runtime-db-identity'

/** Dedicated restricted connection. Never falls back to the ordinary API credential. */
@Injectable()
export class TenantControlDatabase implements OnModuleDestroy {
  private client: PrismaService | null = null
  private verified: Promise<void> | null = null
  configured() { return Boolean(process.env.TENANT_CONTROL_DATABASE_URL && process.env.TENANT_CONTROL_DATABASE_URL !== process.env.DATABASE_URL) }
  private async connection() {
    if (!this.configured()) throw new ServiceUnavailableException({ code: 'TENANT_CONTROL_UNAVAILABLE', message: 'Tenant authoring requires the dedicated restricted database role.' })
    this.client ??= new PrismaService({ datasourceUrl: process.env.TENANT_CONTROL_DATABASE_URL })
    const client = this.client
    this.verified ??= (async () => {
      await assertRuntimeDbIdentity(client, 'Tenant control')
      const [role] = await client.$queryRaw<Array<{ allowed: boolean; dangerous: boolean }>>`SELECT current_user = 'fbeds_tenant_control_login' AS allowed, has_table_privilege(current_user, '"Wallet"', 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege(current_user, '"LedgerEntry"', 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege(current_user, '"Booking"', 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege(current_user, 'users', 'INSERT,UPDATE,DELETE') OR has_column_privilege(current_user, 'users', 'password_hash', 'SELECT') AS dangerous`
      if (!role?.allowed || role.dangerous) throw new Error('Invalid tenant authoring role')
    })().catch(() => { this.verified = null; throw new ServiceUnavailableException({ code: 'TENANT_CONTROL_UNAVAILABLE', message: 'Tenant authoring role verification failed.' }) })
    await this.verified
    return client
  }
  private async execute<T>(run: () => Promise<T>) {
    try { return await run() } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'P2002' || code === 'P2034') throw new ConflictException('Tenant identity or concurrent mutation conflicts with existing data')
      if (isDatabasePermissionDenied(e)) throw new ServiceUnavailableException({ code: 'TENANT_CONTROL_UNAVAILABLE', message: 'Tenant control database permissions are unavailable.' })
      throw e
    }
  }
  async withPlatform<T>(operator: string, work: (tx: Prisma.TransactionClient) => Promise<T>) { const client = await this.connection(); return this.execute(() => client.withPlatform(operator, work)) }
  async withTenant<T>(tenant: string, work: (tx: Prisma.TransactionClient) => Promise<T>) { const client = await this.connection(); return this.execute(() => client.withTenant(tenant, work)) }
  async withPlatformTenant<T>(operator: string, tenant: string, work: (tx: Prisma.TransactionClient) => Promise<T>) { const client = await this.connection(); return this.execute(() => client.withPlatformTenant(operator, tenant, work)) }
  async onModuleDestroy() { await this.client?.$disconnect() }
}
