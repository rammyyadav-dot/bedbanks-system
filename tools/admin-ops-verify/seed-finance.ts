// Finance module seed. See the comment below and README.md.
import { PrismaService } from '../../apps/api/src/database/prisma.service'
import { AgentAuditService } from '../../apps/api/src/agent/audit.service'
import { InventoryHoldService } from '../../apps/api/src/agent/inventory-hold.service'
import { BookingPersistenceService } from '../../apps/api/src/agent/booking-persistence.service'
import { BookingFinancialAuthorizationService } from '../../apps/api/src/agent/booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from '../../apps/api/src/agent/prebook-compensation-recovery.service'
import { SupplierPrebookOrchestrationService } from '../../apps/api/src/agent/supplier-prebook-orchestration.service'
import { SupplierMutationJournalService } from '../../apps/api/src/agent/supplier-mutation-journal.service'
import { BookingConfirmationService } from '../../apps/api/src/agent/booking-confirmation.service'
import { BookingTransactionService } from '../../apps/api/src/agent/booking-transaction.service'
import { BookingCancellationService } from '../../apps/api/src/agent/booking-cancellation.service'
import { CancellationPolicyService } from '../../apps/api/src/agent/cancellation-policy.service'
import { LedgerService } from '../../apps/api/src/agent/ledger.service'
import { hashPassword } from '../../apps/api/src/auth/utils/password'


import { FundingService } from '../../apps/api/src/funding/funding.service'
import { BookingDocumentService } from '../../apps/api/src/agent/booking-document.service'

// Seeds ONE tenant with a realistic finance picture for the Admin Finance module screenshots and recording:
// three agencies (one prepaid, two on credit), funding receipts in every state posted through the real funding service,
// confirmed and cancelled bookings charged to agency accounts through the real booking services, credit notes issued through the
// real document service, unpaid charges back-dated into the notice and refusal bands, and one deliberately broken booking chain
// so the integrity control has something to catch. Writes to the DISPOSABLE local database only. See README.md.
const url = process.env.DATABASE_URL ?? ''
if (!/@localhost:\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')
process.env.FUNDING_ENABLED = 'true'

async function main() {
  const prisma = new PrismaService(); await prisma.$connect()
  const audit = new AgentAuditService(prisma); const holds = new InventoryHoldService(prisma)
  const persistence = new BookingPersistenceService(prisma); const finance = new BookingFinancialAuthorizationService(prisma)
  const recovery = new PrebookCompensationRecoveryService(finance, holds, audit)
  const supplier = { prebook: async () => ({ supplierReference: 'contracted:verify' }) } as any
  const tx = new BookingTransactionService(prisma, new SupplierPrebookOrchestrationService(persistence, finance, recovery, holds, audit, new SupplierMutationJournalService(prisma, audit), supplier), new BookingConfirmationService(prisma))
  const cancels = new BookingCancellationService(prisma, new CancellationPolicyService(), new LedgerService(prisma), audit)
  const funding = new FundingService(prisma, audit)
  const documents = new BookingDocumentService(prisma, audit)
  const password = 'Verify-Passw0rd!'; const hash = await hashPassword(password)
  const tag = `fin-${Date.now()}`
  const stay = new Date(Date.now() + 40 * 86_400_000); const nights = [stay, new Date(stay.getTime() + 86_400_000)]
  const ymd = (d: Date) => d.toISOString().slice(0, 10); const checkIn = ymd(nights[0]); const checkOut = ymd(new Date(stay.getTime() + 2 * 86_400_000))
  const days = (n: number) => `${n} days`

  const t = await prisma.tenant.create({ data: { name: 'Dubai Bedbank (finance demo)', slug: `${tag}-a` } })
  const board = await prisma.boardBasis.create({ data: { tenantId: t.id, code: 'BB', name: 'Bed and breakfast' } })
  async function property(code: string, hotelName: string, supplierName: string, nightlyNet: bigint) {
    const sup = await prisma.supplier.create({ data: { tenantId: t.id, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${supplierName} LLC`, displayName: supplierName, countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await prisma.hotel.create({ data: { tenantId: t.id, name: hotelName, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe King', code: code.slice(0, 20), maxAdults: 2, maxOccupancy: 2 } })
    const contract = await prisma.contract.create({ data: { tenantId: t.id, supplierId: sup.id, code: `${tag}-${code}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })
    const rp = await prisma.ratePlan.create({ data: { tenantId: t.id, contractId: contract.id, roomTypeId: room.id, boardBasisId: board.id, code: `${tag}-${code}`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
    await prisma.dailyAvailability.createMany({ data: nights.map(stayDate => ({ tenantId: t.id, ratePlanId: rp.id, stayDate, allotment: 40 })) })
    await prisma.dailyRate.createMany({ data: nights.map(stayDate => ({ tenantId: t.id, ratePlanId: rp.id, stayDate, occupancy: 2, amountMinor: nightlyNet, currency: 'AED', amountBasis: 'NET' })) })
    await prisma.cancellationPolicy.create({ data: { contractId: contract.id, daysBeforeCheckin: 7, penaltyPercent: 0 } })
    return { sup, hotel, room, rp }
  }
  const marina = await property('MARINA', 'Marina Bay Hotel', 'Marina Bay Hotels', 50_000n)
  const palm = await property('PALM', 'Palm Jumeirah Resort', 'Palm Resorts Group', 52_000n)

  const permsAll = ['booking.read', 'booking.reconcile', 'booking.cancel', 'booking.documents.issue', 'finance.read', 'funding.manage', 'audit.read', 'agency.read', 'agency.manage', 'case.read', 'distribution.read', 'supply.hotels.read', 'supply.suppliers.read', 'supply.rates.read', 'supply.contracts.read']
  async function user(label: string, name: string, role: string, keys: string[]) {
    const u = await prisma.user.create({ data: { email: `${label}-${tag}@demo.test`, name, passwordHash: hash, status: 'ACTIVE' } })
    await prisma.membership.create({ data: { userId: u.id, tenantId: t.id, role } })
    const r = await prisma.role.create({ data: { tenantId: t.id, name: `${label}-${tag}` } })
    for (const key of keys) { const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await prisma.userRole.create({ data: { userId: u.id, roleId: r.id, tenantId: t.id } })
    return u
  }
  const admin = await user('admin', 'Aisha Rahman', 'owner', permsAll)
  const finA = await user('fin-a', 'Omar Siddiqui', 'finance', ['finance.read', 'funding.manage', 'agency.read'])
  const finB = await user('fin-b', 'Priya Nair', 'finance', ['finance.read', 'funding.manage', 'agency.read'])
  const finC = await user('fin-c', 'Rania Haddad', 'finance', ['finance.read', 'funding.manage', 'agency.read'])
  const viewer = await user('viewer', 'Read Only', 'viewer', ['supply.hotels.read'])

  const agencyDefs = [
    { code: 'GULF-HORIZON', name: 'Gulf Horizon Travel', credit: 0n },
    { code: 'DESERT-ROSE', name: 'Desert Rose Tours', credit: 5_000_000n },
    { code: 'AL-NOOR', name: 'Al Noor Holidays', credit: 2_500_000n },
  ]
  const agencies: Record<string, { id: string; booker: { id: string } }> = {}
  for (const d of agencyDefs) {
    const a = await prisma.agency.create({ data: { tenantId: t.id, code: d.code, name: d.name, countryCode: 'AE', createdById: admin.id } })
    const booker = await user(`booker-${d.code.toLowerCase()}`, `${d.name} booker`, 'agent', ['booking.prebook'])
    await prisma.agencyMember.create({ data: { tenantId: t.id, agencyId: a.id, userId: booker.id } as never })
    if (d.credit > 0n) await prisma.agencyCreditLimit.create({ data: { tenantId: t.id, agencyId: a.id, currency: 'AED', limitMinor: d.credit, updatedById: admin.id } })
    agencies[d.code] = { id: a.id, booker }
  }

  // Funding, through the real service and its separation of duties: one person declares, a different one verifies, posting needs a poster who did not verify.
  const rec = (agency: string, amountMinor: string, bankReference: string, extra: Partial<{ method: 'BANK_TRANSFER' | 'CASH_DEPOSIT'; payerType: 'AGENCY' | 'THIRD_PARTY'; payerName: string; valueDaysAgo: number }> = {}) =>
    funding.adminDeclare(t.id, finA.id, { agencyId: agencies[agency].id, currency: 'AED', amountMinor, method: extra.method ?? 'BANK_TRANSFER', bankReference, valueDate: ymd(new Date(Date.now() - (extra.valueDaysAgo ?? 3) * 86_400_000)), payerName: extra.payerName ?? agencyDefs.find(d => d.code === agency)!.name, payerType: extra.payerType ?? 'AGENCY', requestId: `${tag}-${bankReference}` })
  const big = await rec('GULF-HORIZON', '5000000', 'EMIRATESNBD-88120934', { valueDaysAgo: 10 })
  await funding.verify(t.id, finB.id, big.id, { note: 'Matched to Emirates NBD statement 08 Oct' }); await funding.post(t.id, finC.id, big.id)
  const small = await rec('GULF-HORIZON', '800000', 'ENBD-88341102', { valueDaysAgo: 2 })           // declared, awaiting verification
  const six = await rec('DESERT-ROSE', '600000', 'ADCB-55210077', { valueDaysAgo: 1 })              // verified, awaiting posting
  await funding.verify(t.id, finB.id, six.id, { note: 'Matched to ADCB statement' })
  await rec('AL-NOOR', '300000', 'CASH-DEP-20417', { method: 'CASH_DEPOSIT', payerType: 'THIRD_PARTY', payerName: 'Khalid Trading FZE', valueDaysAgo: 1 }) // needs compliance clearance
  const wrong = await rec('AL-NOOR', '120000', 'MASHREQ-10099', { valueDaysAgo: 4 })
  await funding.reject(t.id, finB.id, wrong.id, { reason: 'Reference does not appear on the bank statement' })

  async function book(agency: string, f: typeof marina, key: string, finish: 'confirm' | 'cancel' | 'none') {
    const booker = agencies[agency].booker
    const hold = await holds.create({ tenantId: t.id, userId: booker.id, requestId: `${key}-req`, idempotencyKey: key, offerId: `o-${key}`, searchId: `s-${key}`, ratePlanId: f.rp.id, canonicalHotelId: f.hotel.id, canonicalRoomTypeId: f.room.id, boardBasisId: board.id, checkIn, checkOut, rooms: 1, currency: 'AED', sellAmountMinor: 125_100, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    const pre = await tx.prebook({ tenantId: t.id, userId: booker.id, requestId: `${key}-pre`, inventoryHoldId: hold.holdId, idempotencyKey: key, adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Layla', lastName: 'Hassan' } })
    if (finish !== 'none') await tx.confirm({ tenantId: t.id, userId: booker.id, requestId: `${key}-c`, bookingId: pre.bookingId })
    if (finish === 'cancel') await cancels.cancel({ tenantId: t.id, userId: booker.id, requestId: `${key}-x`, bookingId: pre.bookingId })
    return { ...pre, holdId: hold.holdId }
  }
  const gulf: string[] = []
  for (const [i, f] of [marina, palm, marina, palm].entries()) gulf.push((await book('GULF-HORIZON', f, `${tag}-g${i}`, 'confirm')).bookingId)
  const cancelled = await book('GULF-HORIZON', palm, `${tag}-g-cancel`, 'cancel')
  const stuck = await book('GULF-HORIZON', marina, `${tag}-g-stuck`, 'none')
  const rose = [await book('DESERT-ROSE', marina, `${tag}-r0`, 'confirm'), await book('DESERT-ROSE', palm, `${tag}-r1`, 'confirm'), await book('DESERT-ROSE', marina, `${tag}-r2`, 'confirm')]
  const noor = [await book('AL-NOOR', palm, `${tag}-n0`, 'confirm'), await book('AL-NOOR', marina, `${tag}-n1`, 'confirm')]
  await documents.get({ tenantId: t.id, userId: admin.id, requestId: `${tag}-cn`, bookingId: cancelled.bookingId, type: 'CREDIT_NOTE' })

  // Make time pass: unpaid agency charges fall into the notice (7+ days) and refusal (30+ days) bands; the stuck hold is two days old.
  const age = async (bookingIds: string[], interval: string) => prisma.$executeRawUnsafe(`UPDATE "LedgerEntry" SET immutable_at = now() - interval '${interval}' WHERE tenant_id = '${t.id}' AND reference = ANY($1::text[])`, bookingIds.map(id => `booking:${id}`))
  await age(rose.map(b => b.bookingId), days(12)); await age(noor.map(b => b.bookingId), days(35)); await age([stuck.bookingId], days(2))
  await prisma.$executeRaw`UPDATE "InventoryHold" SET updated_at = now() - interval '2 days' WHERE id = ${stuck.holdId}`
  // One deliberately broken chain for the integrity control to catch: a second refund keyed outside the booking flow, larger than the charge.
  const wallet = await prisma.ledgerEntry.findFirstOrThrow({ where: { tenantId: t.id, reference: `booking:${gulf[0]}`, type: 'DEBIT' } })
  await prisma.ledgerEntry.create({ data: { tenantId: t.id, walletId: wallet.walletId, type: 'REFUND', amountMinor: 200_000n, currency: 'AED', reference: `booking:${gulf[0]}`, idempotencyKey: `manual-adjustment:${tag}` } })
  // Six earlier nights of nightly records (fixtures: the seed has no earlier ledger to have checked), so the history has a shape. Tonight's is taken by the real scheduler.
  for (let n = 6; n >= 1; n--) {
    const d = new Date(Date.now() - n * 86_400_000); const runDate = ymd(d)
    const report = { status: 'PASS', generatedAt: `${runDate}T01:00:03.000Z`, scanned: { accounts: 3, bookings: 6, entries: 20 }, truncated: false, counts: { errors: 0, warnings: 0, byCode: [] }, findings: [], control: [], staleAuthorizationHours: 24 }
    await prisma.ledgerIntegrityRun.create({ data: { tenantId: t.id, runDate: new Date(`${runDate}T00:00:00.000Z`), status: 'PASS', errors: 0, warnings: 0, accountsScanned: 3, bookingsScanned: 6, entriesScanned: 20, report, createdAt: new Date(`${runDate}T01:00:03.000Z`) } })
  }
  const out = { password, adminEmail: `admin-${tag}@demo.test`, finAEmail: `fin-a-${tag}@demo.test`, finBEmail: `fin-b-${tag}@demo.test`, finCEmail: `fin-c-${tag}@demo.test`, viewerEmail: `viewer-${tag}@demo.test`, tenantId: t.id, cancelledBookingId: cancelled.bookingId, confirmedBookingId: gulf[1], agencyIds: Object.fromEntries(Object.entries(agencies).map(([k, v]) => [k, v.id])), tag }
  require('fs').writeFileSync(process.env.SEED_OUT ?? __dirname + '/.seed-finance.json', JSON.stringify(out, null, 2)); console.log('seeded finance demo', tag)
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
