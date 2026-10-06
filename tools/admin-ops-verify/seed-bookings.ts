// Seeds one demo operator tenant with ~40 bookings across all ten statuses, four agencies, five hotels and four currencies, plus Admin users
// for the booking list/detail browser check. Writes to the DISPOSABLE local database only (fbeds_ci or p0N_*). See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'
import { BOOKING_STATUSES } from '../../packages/contracts/src/operations'

const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

const DAY = 86_400_000
const at = (d: number) => new Date(Date.now() + d * DAY)
const ymd = (d: number) => at(d).toISOString().slice(0, 10)
const AGENCIES = ['Travel Republic', 'Atlas Getaways', 'Global Holidays', 'Enterprise Travel Group']
const SUPPLIERS = ['Global Hotel Supply', 'Supplier One', 'Regional DMC']
const HOTELS: Array<[string, string, string, string]> = [['Atlantis The Palm', 'Dubai', 'AE', 'Asia/Dubai'], ['JW Marriott Marquis Dubai', 'Dubai', 'AE', 'Asia/Dubai'], ['Hilton Dubai Palm Jumeirah', 'Dubai', 'AE', 'Asia/Dubai'], ['Hoxton Shoreditch', 'London', 'GB', 'Europe/London'], ['Hotel Arts Barcelona', 'Barcelona', 'ES', 'Europe/Madrid']]
const CURRENCIES = ['USD', 'GBP', 'EUR', 'AED']
const GUESTS: Array<[string, string]> = [['Amira', 'Haddad'], ['Oliver', 'Grant'], ['Sofia', 'Marin'], ['Khalid', 'Rahman'], ['Emma', 'Walsh'], ['Lucas', 'Meyer']]

const randomHex = (n: number) => require('crypto').randomBytes(Math.ceil(n / 2)).toString('hex').toUpperCase().slice(0, n)
async function main() {
  const prisma = new PrismaService()
  const tag = `bk-${Date.now()}`
  const runId = require('crypto').randomBytes(9).toString('hex')
  const password = 'Verify-Passw0rd!'
  const hash = await hashPassword(password)
  const T = (await prisma.tenant.create({ data: { name: `${tag} demo operator`, slug: tag } })).id
  const creator = await prisma.user.create({ data: { email: `creator-${tag}@verify.test`, name: 'creator' } })
  const agencies: string[] = []
  for (const [i, name] of AGENCIES.entries()) agencies.push((await prisma.agency.create({ data: { tenantId: T, code: `A${i}-${tag.slice(-6)}`.toUpperCase(), name, countryCode: 'GB', createdById: creator.id } })).id)
  const hotels: string[] = []
  for (const [name, city, countryCode, timeZone] of HOTELS) hotels.push((await prisma.hotel.create({ data: { tenantId: T, name, propertyType: 'HOTEL', city, countryCode, timeZone } })).id)

  async function user(label: string, keys: string[], agencyId?: string) {
    const email = `${label}-${tag}@verify.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId: T, role: 'agent' } })
    const r = await prisma.role.create({ data: { tenantId: T, name: `${tag}-${label}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId: T } })
    if (agencyId) await prisma.agencyMember.create({ data: { tenantId: T, agencyId, userId: u.id } })
    return email
  }
  const ops = await user('ops', ['booking.read']); const opsAll = await user('opsall', ['booking.read', 'booking.pii.view', 'booking.view.net'])
  const agency = await user('agency', ['booking.view.agency'], agencies[0])
  // Phase 2: an operator who can act, an agency user who can only request, and a hotel/agency for manual entry (the seeded ones).
  const WRITE = ['booking.confirm.manual', 'booking.on-request.resolve', 'booking.amend', 'booking.cancel', 'booking.cancel.nonrefundable', 'booking.no-show.mark', 'booking.rebook', 'booking.supplier-ref.edit', 'booking.manual.create', 'booking.supplier.retry']
  const OPS_ALL = ['booking.ops.view', 'booking.ops.assign', 'booking.ops.escalate', 'booking.ops.resolve', 'booking.ops.note']
  const lead = await user('lead', ['booking.read', 'booking.pii.view', 'booking.view.net', 'agency.read', 'supply.hotels.read', ...WRITE, ...OPS_ALL])
  const viewer = await user('opsviewer', ['booking.read', 'booking.ops.view'])
  const worker = await user('worker', ['booking.read', 'booking.ops.view', 'booking.ops.assign'])
  const worker2 = await user('worker2', ['booking.read', 'booking.ops.view', 'booking.ops.assign'])
  const requester = await user('requester', ['booking.view.agency', 'booking.cancel.request', 'booking.amend.request'], agencies[0])

  // 40 bookings: four per status, rotating agency / supplier / hotel / currency / guest; some Urgent-like (check-in soon, deadline soon),
  // some missing a supplier reference, a few Unassigned (no agency).
  let n = 0
  for (const status of BOOKING_STATUSES) {
    for (let k = 0; k < 4; k++, n++) {
      const hotelIdx = n % HOTELS.length; const nights = 1 + (n % 5); const urgent = k === 0
      const checkIn = urgent ? 1 + (n % 3) : status === 'CHECKED_OUT' || status === 'NO_SHOW' ? -(3 + k) : 5 + n
      const sell = BigInt(80_000 + n * 7_300); const net = (sell * 82n) / 100n
      const hasRef = !['PENDING_SUPPLIER', 'ON_REQUEST', 'REJECTED', 'FAILED'].includes(status) && !(status === 'CONFIRMED' && k === 3)
      const agencyId = n % 10 === 9 ? null : agencies[n % agencies.length]
      const ref = `FB-${runId}${n.toString(16).padStart(2, '0')}`.toUpperCase() // FB- + 20 hex, the production reference shape
      const b = await prisma.booking.create({ data: {
        tenantId: T, reference: ref, supplier: SUPPLIERS[n % SUPPLIERS.length], hotelId: hotels[hotelIdx], status, currency: CURRENCIES[n % CURRENCIES.length], totalMinor: sell, idempotencyKey: `${tag}-${n}`, searchSnapshot: {},
        agencyId, supplierRef: hasRef ? `SUP-${String(1000 + n)}` : null, supplierStatus: hasRef ? 'CONFIRMED' : null, hotelConfirmationNo: hasRef ? `HC-${n}` : null, agentRef: agencyId ? `AG-${n}` : null,
        checkIn: new Date(`${ymd(checkIn)}T00:00:00Z`), checkOut: new Date(`${ymd(checkIn + nights)}T00:00:00Z`), nights, netMinor: net, markupMinor: sell - net,
        paymentStatus: (['UNPAID', 'PAID', 'OVERDUE'] as const)[n % 3], isRefundable: n % 3 !== 0, cancelDeadline: urgent ? at(1 + (n % 2)) : at(checkIn - 3),
        version: status === 'AMEND_REQUESTED' ? 2 : 1, closedAt: status === 'CANCELLED' && k === 3 ? at(-2) : null, createdAt: at(-(n % 25) - 1),
      } })
      await prisma.bookingRoom.create({ data: { tenantId: T, bookingId: b.id, roomName: ['Deluxe Sea View', 'Superior King', 'Family Suite'][n % 3], boardCode: ['BB', 'RO', 'HB'][n % 3], adults: 2, children: n % 4 === 0 ? 1 : 0, childAges: n % 4 === 0 ? [7] : [], sellMinor: sell } })
      const [firstName, lastName] = GUESTS[n % GUESTS.length]
      await prisma.bookingGuest.create({ data: { tenantId: T, bookingId: b.id, firstName, lastName, isLead: true } })
      await prisma.bookingEvent.create({ data: { tenantId: T, bookingId: b.id, toStatus: status, actorType: 'SYSTEM', reason: 'seed', payload: { seeded: true } } })
    }
  }
  // Phase 4 deterministic fixtures, dated relative to the seed time so SLA states are known: an unknown supplier answer, a refused cancellation, a breached pending booking.
  const mins = (m: number) => new Date(Date.now() - m * 60_000)
  async function fixture(tag: string, o: { status: 'PENDING_SUPPLIER' | 'CANCEL_REQUESTED'; supplier: string; created: number; supplierStatus?: string; supplierRef?: string; job?: { kind: 'BOOK' | 'CANCEL'; status: 'UNKNOWN' | 'FAILED'; err: string; minutesAgo: number }; events?: Array<{ action: string; minutesAgo: number }> }) {
    const b = await prisma.booking.create({ data: { tenantId: T, reference: `FB-${randomHex(20)}`, supplier: o.supplier, hotelId: hotels[0], status: o.status, currency: 'AED', totalMinor: 150_000n, idempotencyKey: `${tag}-${runId}`, searchSnapshot: {}, agencyId: agencies[0], isRefundable: true,
      supplierRef: o.supplierRef ?? null, supplierStatus: o.supplierStatus ?? null, checkIn: new Date(`${ymd(60)}T00:00:00Z`), checkOut: new Date(`${ymd(62)}T00:00:00Z`), nights: 2, createdAt: mins(o.created) } })
    await prisma.bookingRoom.create({ data: { tenantId: T, bookingId: b.id, roomName: 'Deluxe Sea View', adults: 2 } })
    await prisma.bookingGuest.create({ data: { tenantId: T, bookingId: b.id, firstName: 'Fixture', lastName: tag, isLead: true } })
    await prisma.bookingEvent.create({ data: { tenantId: T, bookingId: b.id, toStatus: o.status, actorType: 'SYSTEM', reason: 'seed', payload: { seeded: true }, createdAt: mins(o.created) } })
    if (o.status === 'CANCEL_REQUESTED') await prisma.bookingEvent.create({ data: { tenantId: T, bookingId: b.id, fromStatus: 'CONFIRMED', toStatus: 'CANCEL_REQUESTED', actorType: 'USER', action: 'requestCancellation', payload: {}, createdAt: mins(o.created) } })
    for (const e of o.events ?? []) await prisma.bookingEvent.create({ data: { tenantId: T, bookingId: b.id, fromStatus: o.status, toStatus: o.status, actorType: 'SUPPLIER', action: e.action, payload: {}, createdAt: mins(e.minutesAgo) } })
    if (o.job) { const lead0 = await prisma.user.findFirstOrThrow({ where: { email: leadEmail } }); await prisma.bookingSupplierJob.create({ data: { tenantId: T, bookingId: b.id, kind: o.job.kind, status: o.job.status, attempt: o.job.kind === 'BOOK' ? 4 : 1, runAfter: mins(o.job.minutesAgo), requestedByUserId: lead0.id, idempotencyKey: `${tag}-job-${runId}`, requestFingerprint: '0'.repeat(64), lastErrorCode: o.job.err, createdAt: mins(o.job.minutesAgo + 1), updatedAt: mins(o.job.minutesAgo) } }) }
    return b.reference
  }
  const leadEmail = lead
  const opsFixtures = {
    unknown: await fixture('UNKNOWN', { status: 'PENDING_SUPPLIER', supplier: 'mock-confirm', created: 40, supplierStatus: 'UNKNOWN', job: { kind: 'BOOK', status: 'UNKNOWN', err: 'SUPPLIER_UNREACHABLE', minutesAgo: 10 }, events: [{ action: 'supplierUnknown', minutesAgo: 10 }] }),
    cancelFailed: await fixture('CANCELFAIL', { status: 'CANCEL_REQUESTED', supplier: 'mock-cancel-fail', created: 30, supplierRef: 'SUP-FIXTURE', supplierStatus: 'CANCEL_FAILED', job: { kind: 'CANCEL', status: 'FAILED', err: 'CANCEL_NOT_ALLOWED', minutesAgo: 3 }, events: [{ action: 'supplierCancelFailed', minutesAgo: 3 }] }),
    breached: await fixture('BREACHED', { status: 'PENDING_SUPPLIER', supplier: 'Acme Hotels', created: 95 }),
    fresh: await fixture('FRESH', { status: 'PENDING_SUPPLIER', supplier: 'Acme Hotels', created: 2 }),
  }
  const out = { opsFixtures, workerEmail: worker, worker2Email: worker2, opsViewerEmail: viewer, password, opsEmail: ops, opsAllEmail: opsAll, agencyEmail: agency, leadEmail: lead, requesterEmail: requester, tenant: T, tag, bookings: n }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-bookings.json', JSON.stringify(out, null, 2))
  console.log('seeded', n, 'bookings for', tag)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
