import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'
import { bootstrapFirstAdmin, PLATFORM_OWNER_ROLE_ID } from '../src/database/bootstrap-first-admin'
import { checkTarget } from '../src/database/provision-hold-expiry-role.cli'

const prisma = new PrismaClient()
const suffix = `bootstrap-${Date.now()}`
const input = {
  tenantName: 'Bootstrap Test Travel',
  tenantSlug: suffix,
  adminEmail: `Owner-${suffix}@example.test`,
  adminName: 'Bootstrap Owner',
  adminPassword: 'first-password-0123456789',
}

describe('bootstrapFirstAdmin (disposable database)', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates the tenant, owner with every tenant permission, and a platform operator, with audit', async () => {
    const result = await bootstrapFirstAdmin(prisma, input)
    expect(result.tenantCreated).toBe(true)
    expect(result.userCreated).toBe(true)

    const tenantPermissionTotal = await prisma.permission.count()
    expect(result.tenantPermissions).toBe(tenantPermissionTotal)
    const keys = (await prisma.permission.findMany({ select: { key: true } })).map(({ key }) => key)
    expect(keys).toEqual(expect.arrayContaining(['supply.hotels.manage', 'supply.rates.manage', 'booking.read']))

    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId: result.tenantId, name: 'owner' } } })
    expect(await prisma.rolePermission.count({ where: { roleId: ownerRole.id } })).toBe(tenantPermissionTotal)
    expect(await prisma.userRole.count({ where: { userId: result.userId, roleId: ownerRole.id } })).toBe(1)
    expect((await prisma.membership.findFirstOrThrow({ where: { userId: result.userId, tenantId: result.tenantId } })).role).toBe('owner')

    const platformTotal = await prisma.platformPermission.count()
    expect(result.platformPermissions).toBe(platformTotal)
    expect(await prisma.platformRolePermission.count({ where: { roleId: PLATFORM_OWNER_ROLE_ID } })).toBe(platformTotal)
    expect(await prisma.platformRoleAssignment.count({ where: { userId: result.userId, roleId: PLATFORM_OWNER_ROLE_ID } })).toBe(1)

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } })
    expect(user.email).toBe(input.adminEmail.toLowerCase())
    expect(await bcrypt.compare(input.adminPassword, user.passwordHash as string)).toBe(true)

    const audits = await prisma.auditEvent.findMany({ where: { userId: result.userId, action: { startsWith: 'bootstrap.' } } })
    expect(audits.map(({ action }) => action).sort()).toEqual(['bootstrap.platform_owner.provisioned', 'bootstrap.tenant_owner.provisioned'])
    const serialized = JSON.stringify(audits)
    expect(serialized).not.toContain(input.adminPassword)
    expect(serialized).not.toContain(input.adminEmail.toLowerCase())
  })

  it('is idempotent and keeps the existing password unless a reset is requested', async () => {
    const second = await bootstrapFirstAdmin(prisma, { ...input, adminPassword: 'a-different-password-9876543' })
    expect(second.tenantCreated).toBe(false)
    expect(second.userCreated).toBe(false)
    expect(await prisma.membership.count({ where: { userId: second.userId, tenantId: second.tenantId } })).toBe(1)
    expect(await prisma.platformRoleAssignment.count({ where: { userId: second.userId } })).toBe(1)
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: second.userId } })
    expect(await bcrypt.compare(input.adminPassword, unchanged.passwordHash as string)).toBe(true)

    await bootstrapFirstAdmin(prisma, { ...input, adminPassword: 'a-different-password-9876543', resetPassword: true })
    const reset = await prisma.user.findUniqueOrThrow({ where: { id: second.userId } })
    expect(await bcrypt.compare('a-different-password-9876543', reset.passwordHash as string)).toBe(true)
  })

  it('rejects weak or malformed input before touching the database', async () => {
    await expect(bootstrapFirstAdmin(prisma, { ...input, adminPassword: 'short' })).rejects.toThrow('at least 16')
    await expect(bootstrapFirstAdmin(prisma, { ...input, tenantSlug: 'Bad Slug' })).rejects.toThrow('slug')
    await expect(bootstrapFirstAdmin(prisma, { ...input, adminEmail: 'not-an-email' })).rejects.toThrow('email')
  })

  it('refuses a remote target without explicit confirmation of the database name', () => {
    const remote = 'postgresql://owner:secret@db.example.com:5432/prod'
    expect(() => checkTarget(remote, [])).toThrow('Remote target')
    expect(() => checkTarget(remote, ['--allow-remote', '--confirm-database=wrong'])).toThrow('Remote target')
    expect(checkTarget(remote, ['--allow-remote', '--confirm-database=prod'])).toEqual({ host: 'db.example.com', database: 'prod' })
  })
})
