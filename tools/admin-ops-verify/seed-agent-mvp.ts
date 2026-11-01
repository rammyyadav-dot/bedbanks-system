// Seeds the Agent Dubai MVP acceptance scenario (docs/agent-dubai-mvp-completion.md): one tenant with a real contracted catalogue for Dubai
// (30 filler hotels for pagination plus one hotel per evaluator scenario), Agent users and a second tenant. Writes to the DISPOSABLE local
// database only and refuses anything else. See README.md.
import { deflateSync } from 'zlib'
import { createHash } from 'crypto'
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')
const FILLERS = Number(process.env.FILLERS ?? 30)

function makePng(w: number, h: number, rgb: number[]): Buffer {
  const table: number[] = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

async function main() {
  const prisma = new PrismaService()
  const tag = `am-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const B = (await prisma.tenant.create({ data: { name: `${tag}-b`, slug: `${tag}-b` } })).id
  const mk = async (t: string) => ({
    supplierId: (await prisma.supplier.create({ data: { tenantId: t, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} S ${t.slice(-4)}`, displayName: 'Gulf Direct', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id,
    boardBasisId: (await prisma.boardBasis.create({ data: { tenantId: t, code: 'BB', name: 'Bed and breakfast' } })).id,
  })
  const a = await mk(A); const b = await mk(B)
  const ids: Record<string, string> = {}; const plans: Record<string, string[]> = {}; let poolId = ''
  type Opts = { codes?: string[]; pooled?: boolean; mode?: 'ALLOTMENT' | 'ON_REQUEST' | 'CLOSED'; stale?: boolean; price?: bigint; allotment?: number; stars?: number; tenant?: string; ctx?: typeof a; planName?: string }
  async function hotel(key: string, name: string, o: Opts = {}) {
    const t = o.tenant ?? A; const c0 = o.ctx ?? a
    const h = await prisma.hotel.create({ data: { tenantId: t, name, externalRef: `${key}-${tag.slice(-5)}`.slice(0, 40), propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: '1 Verification Road', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: o.stars ?? 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: key === 'long' ? 'Grand Deluxe Corner Suite With Panoramic Marina And Skyline Views And A Very Long Descriptive Name' : 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 3, maxChildren: 2, maxOccupancy: 4 } })
    const m = await prisma.supplierHotelMapping.create({ data: { tenantId: t, supplierId: c0.supplierId, hotelId: h.id, supplierHotelId: `${tag}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId: t, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const ct = await prisma.contract.create({ data: { tenantId: t, supplierId: c0.supplierId, supplierHotelMappingId: m.id, code: `${tag}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(400), settlementCurrency: 'AED' } as never })
    const range = Array.from({ length: 60 }, (_, i) => utc(i))
    const creator = await prisma.user.findFirst({ where: { email: `agent-${tag}@verify.test` } })
    const pool = o.pooled && creator ? await prisma.inventoryPool.create({ data: { tenantId: t, hotelId: h.id, supplierId: c0.supplierId, name: 'Shared pool', createdById: creator.id } }) : null
    if (pool) { await prisma.inventoryPoolDay.createMany({ data: range.map((stayDate) => ({ tenantId: t, poolId: pool.id, stayDate, capacity: 1 })) }); poolId = pool.id }
    plans[key] = []
    for (const code of o.codes ?? ['BB']) {
      const p = await prisma.ratePlan.create({ data: { tenantId: t, contractId: ct.id, roomTypeId: room.id, boardBasisId: c0.boardBasisId, code: `${code}-${key}`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1, inventoryPoolId: pool?.id ?? null } })
      plans[key].push(p.id)
      await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: t, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: o.price ?? 49_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: t, ratePlanId: p.id, stayDate, allotment: pool ? 9 : o.allotment ?? 4, inventoryMode: o.mode ?? 'ALLOTMENT', ...(o.stale ? { source: 'SUPPLIER_FEED' as const, sourceUpdatedAt: new Date(Date.now() - 7_200_000), receivedAt: new Date(Date.now() - 7_200_000), freshUntil: new Date(Date.now() - 3_600_000) } : {}) })) })
    }
    ids[key] = h.id
    return h.id
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: `${label} user`, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role: 'agent' } })
    const r = await prisma.role.create({ data: { tenantId, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return { email, id: u.id }
  }
  const agent = await user('agent', A, ['hotel.search', 'booking.read'])
  const noaccess = await user('noaccess', A, [])
  const bagent = await user('bagent', B, ['hotel.search', 'booking.read'])
  const homeAgent = await user('homeagent', A, ['hotel.search', 'booking.read'])
  await prisma.membership.create({ data: { userId: homeAgent.id, tenantId: B, role: 'agent' } })
  const betaRoles = await prisma.userRole.findMany({ where: { userId: bagent.id, tenantId: B } })
  await prisma.userRole.createMany({ data: betaRoles.map((role) => ({ userId: homeAgent.id, tenantId: B, roleId: role.roleId })) })
  const fillerNames: string[] = []
  for (let i = 1; i <= FILLERS; i++) { const n = `Filler Hotel ${String(i).padStart(2, '0')}`; fillerNames.push(n); await hotel(`f${i}`, n, { price: BigInt(30_000 + i * 700), stars: 3 + (i % 3) }) }
  const pic = await hotel('pic', 'Scenario Image Palace', { price: 51_000n })
  const png = makePng(800, 600, [20, 120, 180])
  await prisma.hotelImage.create({ data: { tenantId: A, hotelId: pic, contentType: 'image/png', bytes: png.length, width: 800, height: 600, sha256: createHash('sha256').update(png).digest('hex'), altText: 'Blue pool deck', sortOrder: 0, isPrimary: true, data: png, uploadedById: 'seed' } as never })
  await hotel('long', 'Scenario Grand Waterfront Residences And Conference Resort At The Dubai Marina With An Exceptionally Long Name', { price: 52_000n, codes: ['LONGPLANCODEFORWRAPPING'] })
  await hotel('pool', 'Scenario Shared Pool Tower', { pooled: true, codes: ['P1', 'P2', 'P3'], price: 53_000n })
  await hotel('stale', 'Scenario Stale Supplier Inn', { stale: true, price: 20_000n })
  await hotel('onreq', 'Scenario On Request Suites', { mode: 'ON_REQUEST', price: 54_000n })
  await hotel('closed', 'Scenario Closed Court', { mode: 'CLOSED', price: 55_000n })
  await hotel('change', 'Scenario Price Change Plaza', { price: 56_000n })
  await hotel('gone', 'Scenario Unavailable Residence', { price: 57_000n, allotment: 1 })
  await hotel('beta', 'Beta Tenant Only Hotel', { tenant: B, ctx: b, price: 58_000n })
  const out = { password, tag, tenantA: A, tenantB: B, agentEmail: agent.email, noaccessEmail: noaccess.email, bagentEmail: bagent.email, homeAgentEmail: homeAgent.email, hotels: ids, plans, poolId, fillerNames, names: { pic: 'Scenario Image Palace', pool: 'Scenario Shared Pool Tower', stale: 'Scenario Stale Supplier Inn', onreq: 'Scenario On Request Suites', closed: 'Scenario Closed Court', change: 'Scenario Price Change Plaza', gone: 'Scenario Unavailable Residence', long: 'Scenario Grand Waterfront Residences And Conference Resort At The Dubai Marina With An Exceptionally Long Name', beta: 'Beta Tenant Only Hotel' }, fillers: FILLERS }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-agent-mvp.json', JSON.stringify(out, null, 2))
  console.log(`seeded ${FILLERS} filler hotels and 8 scenario hotels (tenant A), 1 hotel (tenant B)`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
