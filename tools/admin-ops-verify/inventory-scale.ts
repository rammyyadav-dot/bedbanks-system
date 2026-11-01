// Inventory & Allotment scale acceptance (ADR 0030): seeds N hotels (each with three plans over one shared pool of 5, plus deliberate
// exhausted / on-request / closed-to-departure cases), then checks Agent search against the expected result for every plan, the Admin
// inventory summary (on the restricted runtime role when RUNTIME_DATABASE_URL is set), and exactly-once pool allocation under concurrency (owner connection: the runtime role has no hold-write grants by design). Prints observed numbers only. DISPOSABLE local database only.
//   N=100 node --no-experimental-strip-types -r @swc-node/register tools/admin-ops-verify/inventory-scale.ts   (run from apps/api)
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { ContractedInventoryAdapter } from '../../apps/api/src/agent/contracted-inventory.adapter'
import { InventoryAdminService } from '../../apps/api/src/inventory/inventory-admin.service'
import { InventoryHoldService } from '../../apps/api/src/agent/inventory-hold.service'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p04_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p04_*)')
const SAMPLES = Number(process.env.SAMPLES ?? '15')
const N = Number(process.env.N ?? '10')
if (![1, 10, 100].includes(N)) throw new Error('N must be 1, 10 or 100')

const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
const day = (o: number) => new Date(midnight + o * 86_400_000).toISOString().slice(0, 10)
const utc = (o: number) => new Date(midnight + o * 86_400_000)
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] }

async function main() {
  const prisma = new PrismaService() // owner connection: seeding and the write-path concurrency check only
  // Search, recheck and the Admin summary are measured on the restricted runtime login role when RUNTIME_DATABASE_URL is set.
  const runtime = process.env.RUNTIME_DATABASE_URL ? new PrismaService({ datasourceUrl: process.env.RUNTIME_DATABASE_URL } as never) : prisma
  if (runtime !== prisma) await runtime.$connect()
  const [roleInfo] = await runtime.$queryRawUnsafe<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>('SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user')
  if (runtime !== prisma && (roleInfo.rolsuper || roleInfo.rolbypassrls)) throw new Error('refusing: the runtime connection must not be a superuser or BYPASSRLS role')
  const adapter = new ContractedInventoryAdapter(runtime)
  const admin = new InventoryAdminService(runtime)
  const holds = new InventoryHoldService(prisma)
  const tag = `sc${N}-${Date.now()}`
  const tenantId = (await prisma.tenant.create({ data: { name: tag, slug: tag } })).id
  const userId = (await prisma.user.create({ data: { email: `${tag}@verify.test` } })).id
  await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
  const supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: tag, displayName: 'Gulf Direct', countryCode: 'AE', defaultCurrency: 'AED' } })).id
  const boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: 'Bed and breakfast' } })).id
  const expected = new Map<string, 'absent' | 'available' | 'on_request'>() // ratePlanId -> expectation for the searched stay
  const poolOf: Array<{ poolId: string; planIds: string[]; hotelId: string; roomId: string }> = []
  const seedStart = Date.now()
  for (let i = 1; i <= N; i++) {
    const hotelId = (await prisma.hotel.create({ data: { tenantId, name: `Scale Hotel ${String(i).padStart(3, '0')}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', starRating: 5 } })).id
    const roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Deluxe', code: `D${i}`, maxAdults: 2, maxOccupancy: 2 } })).id
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${tag}-h${i}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${tag}-r${i}`, roomTypeId: roomId, status: 'MAPPED' } })
    const contractId = (await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${tag}-c${i}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } })).id
    const poolId = (await prisma.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name: 'Shared 5', createdById: userId } })).id
    const exhausted = i % 10 === 0
    await prisma.inventoryPoolDay.createMany({ data: Array.from({ length: 30 }, (_, d) => ({ tenantId, poolId, stayDate: utc(d), capacity: 5, sold: exhausted ? 5 : 0 })) })
    const planIds: string[] = []
    for (const code of ['P1', 'P2', 'P3']) {
      const planId = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', inventoryPoolId: poolId } })).id
      planIds.push(planId)
      await prisma.dailyRate.createMany({ data: Array.from({ length: 30 }, (_, d) => ({ tenantId, ratePlanId: planId, stayDate: utc(d), occupancy: 2, amountMinor: 49_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await prisma.dailyAvailability.createMany({ data: Array.from({ length: 30 }, (_, d) => ({
        tenantId, ratePlanId: planId, stayDate: utc(d), allotment: 99,
        inventoryMode: code === 'P3' && i % 7 === 0 && d >= 10 && d <= 11 ? 'ON_REQUEST' as const : 'ALLOTMENT' as const,
        closedToDeparture: code === 'P2' && i % 5 === 0 && d === 12,
      })) })
      const onRequest = code === 'P3' && i % 7 === 0
      const ctd = code === 'P2' && i % 5 === 0
      // ON_REQUEST is not stock-bound, so it stays on request even when the pool is sold out; closed-to-departure always removes the stay.
      expected.set(planId, ctd ? 'absent' : onRequest ? 'on_request' : exhausted ? 'absent' : 'available')
    }
    poolOf.push({ poolId, planIds, hotelId, roomId })
  }
  const seedMs = Date.now() - seedStart

  // ---- Agent search vs expectation, repeated for latency -----------------------------------------------------------------------
  const criteria = { destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED' }
  const timings: number[] = []; let found: Map<string, { availability: string; available: boolean }> = new Map(); let lastRates: Array<{ offerId: string; availability: string; available: boolean }> = []
  for (let run = 0; run < SAMPLES; run++) {
    const t0 = process.hrtime.bigint()
    const result = await adapter.search(criteria, { tenantId, requestId: `scale-${run}` })
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6)
    const flat = result.offers.flatMap((h) => h.rooms.flatMap((r) => r.rates)); lastRates = flat
    found = new Map(flat.map((r) => [r.ratePlanId, { availability: r.availability, available: r.available }]))
  }
  const mismatchDetail: Array<{ hotel: number; plan: number; want: string; actual: string }> = []
  let mismatches = 0; const counts = { available: 0, on_request: 0, absent: 0 }
  for (const [planId, want] of expected) {
    const got = found.get(planId)
    const actual = got ? (got.availability === 'on_request' ? 'on_request' : got.available ? 'available' : 'other') : 'absent'
    counts[want] += 1
    if (actual !== want) { mismatches += 1; const idx = poolOf.findIndex((p) => p.planIds.includes(planId)); mismatchDetail.push({ hotel: idx + 1, plan: poolOf[idx].planIds.indexOf(planId) + 1, want, actual }) }
  }
  const overstated = [...found.values()].filter((r) => r.available && r.availability === 'on_request').length

  // ---- recheck of the offers just returned (restricted role): available stays available, on-request is never upgraded ---------------------
  const recheckTimings: number[] = []; let recheckWrong = 0
  for (const rate of lastRates.slice(0, 60)) {
    const t0 = process.hrtime.bigint()
    const r = await adapter.recheck({ offerId: rate.offerId, searchId: 'scale' }, { tenantId, userId, requestId: 'scale-recheck' })
    recheckTimings.push(Number(process.hrtime.bigint() - t0) / 1e6)
    const want = rate.available ? 'available' : 'unavailable'
    if (r.status !== want) recheckWrong += 1
  }

  // ---- Admin summary latency for the first hotel and the pool arithmetic -----------------------------------------------------------
  const summaryTimings: number[] = []; let poolShown = 0
  for (let run = 0; run < SAMPLES; run++) {
    const t0 = process.hrtime.bigint()
    const s = await admin.summary(tenantId, poolOf[0].hotelId, { days: 30 })
    summaryTimings.push(Number(process.hrtime.bigint() - t0) / 1e6)
    poolShown = s.pools[0].nights[0].remaining ?? -1
  }

  // ---- exactly-once pool allocation under concurrency (sample of up to 20 non-exhausted pools) --------------------------------------
  const sample = poolOf.filter((_, idx) => (idx + 1) % 10 !== 0).slice(0, 20)
  const t1 = Date.now(); let wrong = 0; let totalWon = 0; let totalTried = 0
  await Promise.all(sample.map(async (p, k) => {
    const tries = 12
    const results = await Promise.allSettled(Array.from({ length: tries }, (_, j) => holds.create({
      tenantId, userId, requestId: `c-${k}-${j}`, idempotencyKey: `${tag}-k${k}-${j}`, offerId: 'o', searchId: 's', ratePlanId: p.planIds[j % 3], canonicalHotelId: p.hotelId,
      canonicalRoomTypeId: p.roomId, boardBasisId: boardId, checkIn: day(10), checkOut: day(11), rooms: 1, currency: 'AED', sellAmountMinor: 49_900, offerExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    })))
    const won = results.filter((r) => r.status === 'fulfilled').length
    totalWon += won; totalTried += tries
    const day10 = await prisma.inventoryPoolDay.findFirstOrThrow({ where: { poolId: p.poolId, stayDate: utc(10) } })
    if (won !== 5 || day10.held !== 5 || day10.sold + day10.held > day10.capacity) wrong += 1
  }))
  const concurrencyMs = Date.now() - t1

  const out = {
    measuredAs: { role: roleInfo.current_user, superuser: roleInfo.rolsuper, bypassRls: roleInfo.rolbypassrls, restrictedRuntime: runtime !== prisma },
    hotels: N, ratePlans: N * 3, poolNightsSeeded: N * 30, seedMs,
    search: { runs: timings.length, p50Ms: +pct(timings, 50).toFixed(1), p95Ms: +pct(timings, 95).toFixed(1), maxMs: +Math.max(...timings).toFixed(1), plansExpected: counts, mismatches, mismatchDetail, overstatedAvailability: overstated, offersReturned: found.size },
    recheck: { samples: recheckTimings.length, p50Ms: +pct(recheckTimings, 50).toFixed(1), p95Ms: +pct(recheckTimings, 95).toFixed(1), wrongOutcomes: recheckWrong },
    adminSummary: { runs: summaryTimings.length, p50Ms: +pct(summaryTimings, 50).toFixed(1), p95Ms: +pct(summaryTimings, 95).toFixed(1), firstPoolNightRemaining: poolShown },
    concurrency: { poolsTested: sample.length, attemptsPerPool: 12, totalAttempts: totalTried, totalHeld: totalWon, poolsWithWrongCount: wrong, ms: concurrencyMs },
  }
  console.log(JSON.stringify(out, null, 2))
  require('fs').writeFileSync(process.env.SCALE_OUT ?? `${__dirname}/.scale-${N}.json`, JSON.stringify(out, null, 2))
  if (runtime !== prisma) await runtime.$disconnect()
  await prisma.$disconnect()
  if (mismatches > 0 || overstated > 0 || wrong > 0 || recheckWrong > 0) process.exit(2)
}
main().catch((e) => { console.error(e); process.exit(1) })
