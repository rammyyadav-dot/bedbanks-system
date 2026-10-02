// Seeds two tenants (owner, viewer, other-tenant owner) with confirmed / cancelled / stuck bookings for the Admin browser check.
// Writes to the DISPOSABLE local database only and refuses anything else. See README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { AgentAuditService } from '../../apps/api/src/agent/audit.service'
import { InventoryHoldService } from '../../apps/api/src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../../apps/api/src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../../apps/api/src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../../apps/api/src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../../apps/api/src/agent/supplier-prebook-orchestration.service'
import { BookingConfirmationService } from '../../apps/api/src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../../apps/api/src/agent/booking-transaction.service'
import { BookingCancellationService } from '../../apps/api/src/agent/booking-cancellation.service'
import { CancellationPolicyService } from '../../apps/api/src/agent/cancellation-policy.service'
import { LedgerService } from '../../apps/api/src/agent/ledger.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'

const url = process.env.DATABASE_URL ?? ''
if (!/localhost:5432\/fbeds_ci(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be the disposable local fbeds_ci database')

async function main() {
  const prisma = new PrismaService(); await prisma.$connect()
  const audit = new AgentAuditService(prisma); const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma); const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:verify' }) } as any
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, supplier), new BookingConfirmationService(prisma))
  const cancels = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const password = 'Verify-Passw0rd!'; const hash = await hashPassword(password)
  const stay = new Date(Date.now() + 40 * 86_400_000); const nights = [stay, new Date(stay.getTime() + 86_400_000)]
  const ymd = (d: Date) => d.toISOString().slice(0, 10); const checkIn = ymd(nights[0]); const checkOut = ymd(new Date(stay.getTime() + 2 * 86_400_000))
  const tag = `verify-${Date.now()}`
  async function tenant(slug: string) {
    const t = await prisma.tenant.create({ data: { name: slug, slug } })
    const sup = await prisma.supplier.create({ data: { tenantId: t.id, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${slug} s`, displayName: `${slug} supplier`, countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await prisma.hotel.create({ data: { tenantId: t.id, name: `${slug} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: slug.slice(0, 20), maxAdults: 2, maxOccupancy: 2 } })
    const board = await prisma.boardBasis.create({ data: { tenantId: t.id, code: 'RO', name: 'Room only' } })
    const contract = await prisma.contract.create({ data: { tenantId: t.id, supplierId: sup.id, code: slug, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
    const rp = await prisma.ratePlan.create({ data: { tenantId: t.id, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: slug, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
    await prisma.dailyAvailability.createMany({ data: nights.map(stayDate => ({ tenantId: t.id, ratePlanId: rp.id, stayDate, allotment: 20 })) })
    await prisma.dailyRate.createMany({ data: nights.map(stayDate => ({ tenantId: t.id, ratePlanId: rp.id, stayDate, occupancy: 2, amountMinor: 62_550n, currency: 'AED', amountBasis: 'SELL' })) })
    await prisma.wallet.create({ data: { tenantId: t.id, currency: 'AED', creditLimit: 1_000_000n, cachedBalance: 0n } })
    await prisma.cancellationPolicy.create({ data: { contractId: contract.id, daysBeforeCheckin: 7, penaltyPercent: 0 } })
    return { t, sup, hotel, room, board, rp }
  }
  async function user(email: string, tenantId: string, role: string, permKeys: string[]) {
    const u = await prisma.user.create({ data: { email, name: email.split('@')[0], passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId, role } })
    const r = await prisma.role.create({ data: { tenantId, name: `${role}-${tag}` } })
    for (const key of permKeys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId } })
    return u
  }
  const A = await tenant(`${tag}-a`); const B = await tenant(`${tag}-b`)
  const all = ['booking.read', 'booking.reconcile', 'booking.cancel', 'finance.read', 'audit.read', 'supply.hotels.read', 'supply.suppliers.read', 'supply.rates.read', 'supply.contracts.read', 'supply.mappings.read']
  const owner = await user(`owner-${tag}@verify.test`, A.t.id, 'owner', all)
  await user(`viewer-${tag}@verify.test`, A.t.id, 'viewer', ['supply.hotels.read'])
  await user(`bowner-${tag}@verify.test`, B.t.id, 'owner', all)
  async function book(f: typeof A, key: string, finish: 'confirm' | 'cancel' | 'none') {
    const hold = await holds.create({ tenantId: f.t.id, userId: owner.id, requestId: `${key}-req`, idempotencyKey: key, offerId: `o-${key}`, searchId: `s-${key}`, ratePlanId: f.rp.id, canonicalHotelId: f.hotel.id, canonicalRoomTypeId: f.room.id, boardBasisId: f.board.id, checkIn, checkOut, rooms: 1, currency: 'AED', sellAmountMinor: 125_100, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    const pre = await tx.prebook({ tenantId: f.t.id, userId: owner.id, requestId: `${key}-pre`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Layla', lastName: 'Hassan' } })
    if (finish !== 'none') await tx.confirm({ tenantId: f.t.id, userId: owner.id, requestId: `${key}-c`, bookingId: pre.bookingId })
    if (finish === 'cancel') await cancels.cancel({ tenantId: f.t.id, userId: owner.id, requestId: `${key}-x`, bookingId: pre.bookingId })
    return { ...pre, holdId: hold.holdId }
  }
  const c = await book(A, `${tag}-confirmed`, 'confirm'); await book(A, `${tag}-cancelled`, 'cancel'); const s = await book(A, `${tag}-stuck`, 'none')
  await prisma.$executeRaw`UPDATE "InventoryHold" SET updated_at = now() - interval '2 hours' WHERE id = ${s.holdId}`
  await prisma.$executeRaw`UPDATE "AuditEvent" SET created_at = now() - interval '2 hours' WHERE action = 'booking.prebook.succeeded' AND entity_id = ${s.bookingId}`
  await book(B, `${tag}-b`, 'confirm')
  await prisma.connectorDefinition.create({ data: { tenantId: A.t.id, supplierId: A.sup.id, type: 'API_JSON', status: 'DRAFT', name: `${tag} connector`, version: '1', credentialReferences: { create: [{ secretRef: 'vault://never-shown', purpose: 'api_key' }] } } })
  const out = { password, ownerEmail: `owner-${tag}@verify.test`, viewerEmail: `viewer-${tag}@verify.test`, bownerEmail: `bowner-${tag}@verify.test`, confirmedBookingId: c.bookingId, stuckBookingId: s.bookingId, tenantA: A.t.id, tenantB: B.t.id, hotelAName: `${tag}-a hotel` }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed.json', JSON.stringify(out, null, 2)); console.log('seeded', Object.keys(out).join(','))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
