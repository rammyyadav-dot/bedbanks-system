// Seeds one tenant with two published, sellable Dubai hotels (one with a real primary image, one without) and an Agent user, for the
// Agent thumbnail browser check. Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { deflateSync } from 'zlib'
import { createHash } from 'crypto'
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

/** A real, decodable solid-colour PNG. */
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
  const tag = `ai-${Date.now()}`
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  const A = (await prisma.tenant.create({ data: { name: `${tag}-a`, slug: `${tag}-a` } })).id
  const supplierId = (await prisma.supplier.create({ data: { tenantId: A, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${tag} S`, displayName: 'Gulf Direct', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
  const boardBasisId = (await prisma.boardBasis.create({ data: { tenantId: A, code: 'BB', name: 'Bed and breakfast' } })).id
  const ids: Record<string, string> = {}
  async function hotel(key: string, name: string) {
    const h = await prisma.hotel.create({ data: { tenantId: A, name, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: '1 Verification Road', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: h.id, name: 'Deluxe', code: `D-${key}`, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const m = await prisma.supplierHotelMapping.create({ data: { tenantId: A, supplierId, hotelId: h.id, supplierHotelId: `${tag}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId: A, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${tag}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const c = await prisma.contract.create({ data: { tenantId: A, supplierId, supplierHotelMappingId: m.id, code: `${tag}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(400), settlementCurrency: 'AED' } as never })
    const p = await prisma.ratePlan.create({ data: { tenantId: A, contractId: c.id, roomTypeId: room.id, boardBasisId, code: `${key}-BB`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const range = Array.from({ length: 60 }, (_, i) => utc(i))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: 49_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: A, ratePlanId: p.id, stayDate, allotment: 5, sold: 0, stopSell: false })) })
    ids[key] = h.id
  }
  await hotel('pic', 'Atlantis Verification Palm'); await hotel('nopic', 'Burj Verification View')
  const png = makePng(800, 600, [20, 120, 180])
  await prisma.hotelImage.create({ data: { tenantId: A, hotelId: ids.pic, contentType: 'image/png', bytes: png.length, width: 800, height: 600, sha256: createHash('sha256').update(png).digest('hex'), altText: 'Blue pool deck', sortOrder: 0, isPrimary: true, data: png, uploadedById: 'seed' } })
  const email = `agent-${tag}@verify.test`
  const u = await prisma.user.create({ data: { email, name: 'Agent', passwordHash: hash, status: 'ACTIVE' } })
  await prisma.membership.create({ data: { userId: u.id, tenantId: A, role: 'agent' } })
  const r = await prisma.role.create({ data: { tenantId: A, name: `${tag}-agent` } })
  for (const key of ['hotel.search', 'booking.prebook', 'booking.create', 'booking.read']) {
    const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
    await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
  }
  await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId: A } })
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-agent-images.json', JSON.stringify({ password, agentEmail: email, hotels: ids, names: { pic: 'Atlantis Verification Palm', nopic: 'Burj Verification View' }, tenantA: A, tag }, null, 2))
  console.log('seeded 2 hotels')
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
