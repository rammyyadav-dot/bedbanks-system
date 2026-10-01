import type { Prisma, PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'

export const PLATFORM_OWNER_ROLE_ID = 'platform_owner'
const BCRYPT_SALT_ROUNDS = 12
const MIN_PASSWORD_LENGTH = 16

/** Permissions the agent-side services check that no migration inserts. */
const BOOKING_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ['hotel.search', 'Search hotel availability'],
  ['booking.prebook', 'Prebook a hotel rate'],
  ['booking.create', 'Create a booking'],
  ['booking.cancel', 'Cancel a booking'],
  ['finance.read', 'View tenant finance'],
  ['audit.read', 'View tenant audit events'],
  ['booking.reconcile', 'Reconcile interrupted booking attempts'],
  ['booking.read', 'View booking vouchers, invoices and credit notes'],
]

export interface BootstrapFirstAdminInput {
  tenantName: string
  tenantSlug: string
  adminEmail: string
  adminName: string
  adminPassword: string
  /** Overwrite the password of an existing user. Off by default. */
  resetPassword?: boolean
}

export interface BootstrapFirstAdminResult {
  tenantId: string
  userId: string
  tenantCreated: boolean
  userCreated: boolean
  tenantPermissions: number
  platformPermissions: number
}

/**
 * Owner-run, idempotent creation of the first real tenant, its owner user and a
 * platform operator. This is the one out-of-band path that bypasses the API rule
 * against self-escalation; it exists because the API can only assign platform roles
 * on behalf of an existing platform operator. Every run writes audit events that
 * contain ids only (no email, name or password).
 */
export async function bootstrapFirstAdmin(prisma: PrismaClient, input: BootstrapFirstAdminInput): Promise<BootstrapFirstAdminResult> {
  const email = input.adminEmail.trim().toLowerCase()
  const slug = input.tenantSlug.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid admin email is required')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Tenant slug must be lowercase letters, digits and single hyphens')
  if (!input.tenantName.trim() || !input.adminName.trim()) throw new Error('Tenant name and admin name are required')
  if (input.adminPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`Admin password must be at least ${MIN_PASSWORD_LENGTH} characters`)

  const passwordHash = await bcrypt.hash(input.adminPassword, BCRYPT_SALT_ROUNDS)

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existingTenant = await tx.tenant.findUnique({ where: { slug } })
    const tenant = existingTenant ?? (await tx.tenant.create({ data: { name: input.tenantName.trim(), slug, status: 'ACTIVE' } }))
    const existingUser = await tx.user.findUnique({ where: { email } })
    const user = existingUser
      ? input.resetPassword
        ? await tx.user.update({ where: { id: existingUser.id }, data: { passwordHash, status: 'ACTIVE' } })
        : existingUser
      : await tx.user.create({ data: { email, name: input.adminName.trim(), passwordHash, status: 'ACTIVE' } })

    await tx.$executeRaw`SELECT set_config('app.platform_access', 'true', true)`
    await tx.$executeRaw`SELECT set_config('app.platform_operator_id', ${user.id}, true)`
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant.id}, true)`

    for (const [key, description] of BOOKING_PERMISSIONS) {
      await tx.permission.upsert({ where: { key }, update: {}, create: { key, description } })
    }
    const permissions = await tx.permission.findMany({ select: { id: true } })
    await tx.membership.upsert({
      where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
      update: { role: 'owner' },
      create: { userId: user.id, tenantId: tenant.id, role: 'owner' },
    })
    const ownerRole = await tx.role.upsert({ where: { tenantId_name: { tenantId: tenant.id, name: 'owner' } }, update: {}, create: { tenantId: tenant.id, name: 'owner' } })
    await tx.rolePermission.createMany({ data: permissions.map(({ id }) => ({ roleId: ownerRole.id, permissionId: id })), skipDuplicates: true })
    await tx.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: ownerRole.id } },
      update: { tenantId: tenant.id },
      create: { userId: user.id, roleId: ownerRole.id, tenantId: tenant.id },
    })

    const platformRole = await tx.platformRole.upsert({
      where: { id: PLATFORM_OWNER_ROLE_ID },
      update: {},
      create: { id: PLATFORM_OWNER_ROLE_ID, name: 'platform_owner', description: 'Full platform administration (bootstrap role).' },
    })
    const platformPermissions = await tx.platformPermission.findMany({ select: { id: true } })
    await tx.platformRolePermission.createMany({ data: platformPermissions.map(({ id }) => ({ roleId: platformRole.id, permissionId: id })), skipDuplicates: true })
    await tx.platformRoleAssignment.upsert({
      where: { userId_roleId: { userId: user.id, roleId: platformRole.id } },
      update: {},
      create: { userId: user.id, roleId: platformRole.id },
    })

    const outcome = { outcome: 'allowed', tenantCreated: !existingTenant, userCreated: !existingUser, passwordReset: Boolean(existingUser && input.resetPassword) }
    await tx.auditEvent.create({ data: { tenantId: tenant.id, userId: user.id, actorType: 'USER', action: 'bootstrap.tenant_owner.provisioned', entityType: 'tenant', entityId: tenant.id, payload: { ...outcome, permissionCount: permissions.length } } })
    await tx.auditEvent.create({ data: { tenantId: null, userId: user.id, actorType: 'USER', action: 'bootstrap.platform_owner.provisioned', entityType: 'platform_role_assignment', entityId: `${user.id}:${platformRole.id}`, payload: { ...outcome, permissionCount: platformPermissions.length } } })

    return { tenantId: tenant.id, userId: user.id, tenantCreated: !existingTenant, userCreated: !existingUser, tenantPermissions: permissions.length, platformPermissions: platformPermissions.length }
  })
}
