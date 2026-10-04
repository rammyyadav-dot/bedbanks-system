// Seeds one tenant with an agency and two Admin users who can read and manage agencies, for the credit-limit browser check.
// Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

async function main() {
  const prisma = new PrismaService()
  const tag = `cv-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  async function user(label: string, keys: string[]) {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId: A, role: 'owner' } })
    const r = await prisma.role.create({ data: { tenantId: A, name: `${tag}-${label}` } })
    for (const key of keys) {
      const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
      await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
    }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId: A } })
    return { email, id: u.id }
  }
  const keys = ['agency.read', 'agency.manage', 'case.read', 'distribution.read']
  const maker = await user('maker', keys); const checker = await user('checker', keys)
  const agency = await prisma.agency.create({ data: { tenantId: A, code: `VERIFY-${tag.slice(-4).toUpperCase()}`, name: 'Verify Travel LLC', countryCode: 'AE', createdById: maker.id } })
  const out = { password, makerEmail: maker.email, checkerEmail: checker.email, agencyId: agency.id, agencyName: agency.name, tenantA: A, tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-credit.json', JSON.stringify(out, null, 2))
  console.log('seeded agency', agency.code)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
