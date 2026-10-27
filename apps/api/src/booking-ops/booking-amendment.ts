import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  amendedCancelDeadline, amendedNetAndMarkup, amendmentDifference, BOOKING_AMENDMENT_FAILURE, validateAmendmentApproval, validateAmendmentProposal,
  type AmendmentChange, type AmendmentState, type BookingAmendmentProposal,
} from '@bedbanks/contracts'
import { emitAmendmentFinance } from './booking-finance-events'

/**
 * Structured amendments (ADR 0072). Every function takes the caller's write transaction on the booking role and runs inside the same transaction as the status move that
 * `transitionBooking` makes, so an amendment is applied completely or not at all. The booking's stay, price and occupancy are written HERE and nowhere else (a source-scan test
 * enforces it); the status is still written only by `transitionBooking`.
 *
 * What it will not do: move money. An approved price difference is recorded as an "awaiting Finance booking" fact. If the booking was charged on the agency ledger, a
 * price-changing amendment is refused (the ledger adjustment it would need is a finance decision that is not built): changing the total under a ledger charge would make a later
 * cancellation settlement refund the wrong amount.
 */
type Tx = Prisma.TransactionClient
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
const rejectIssues = (code: string, issues: Array<{ field: string; message: string }>) => new UnprocessableEntityException({ message: issues.map((i) => i.message).join('; '), code, issues })

export interface AmendmentSubjectRow { id: string; version: number; status: string; currency: string; paymentMode: string | null; totalMinor: bigint; netMinor: bigint | null; checkIn: Date | null; checkOut: Date | null; nights: number | null; cancelDeadline: Date | null; inventoryBacked: boolean; rooms: Array<{ position: number; adults: number; children: number; childAges: number[] }> }

/** Locks the booking row for the length of the transaction and reads what an amendment needs. */
export async function loadAmendmentSubject(tx: Tx, tenantId: string, bookingId: string): Promise<AmendmentSubjectRow | null> {
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`
  const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, version: true, status: true, currency: true, paymentMode: true, totalMinor: true, netMinor: true, checkIn: true, checkOut: true, nights: true, cancelDeadline: true, searchSnapshot: true, rooms: { orderBy: { position: 'asc' }, select: { position: true, adults: true, children: true, childAges: true } } } })
  return b && { ...b, inventoryBacked: typeof (b.searchSnapshot as { inventoryHoldId?: unknown } | null)?.inventoryHoldId === 'string' }
}

/**
 * A booking sold from contracted inventory has nights allocated against its hold. Changing its stay or occupancy would have to move that inventory and the frozen
 * snapshot the documents and cancellation read, which is not built (ADR 0101), so such a change is refused instead of leaving them on the old stay.
 */
function refuseInventoryBacked(subject: AmendmentSubjectRow, changes: AmendmentChange[]) {
  if (subject.inventoryBacked && changes.length > 0) {
    throw new ConflictException({ message: 'This booking was sold from contracted inventory. Changing its dates or occupancy needs the inventory re-allocated, which is not built yet. Cancel and rebook instead.', code: BOOKING_AMENDMENT_FAILURE.inventoryBacked })
  }
}

export const stateOf = (b: AmendmentSubjectRow): AmendmentState => ({
  checkIn: isoDay(b.checkIn), checkOut: isoDay(b.checkOut), nights: b.nights, rooms: b.rooms.map((r) => ({ position: r.position, adults: r.adults, children: r.children, childAges: [...r.childAges].sort((x, y) => x - y) })),
  sellMinor: b.totalMinor.toString(), netMinor: b.netMinor === null ? null : b.netMinor.toString(), cancelDeadline: b.cancelDeadline ? b.cancelDeadline.toISOString() : null,
})

/** Canonical JSON (keys sorted) so the same body always has the same text, whatever order the client wrote it in. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)])) : v)
  return JSON.stringify(sort(value))
}
/** The text added to a request's idempotency fingerprint: the structured body, or nothing for every other request (so existing fingerprints are unchanged). */
export function amendmentFingerprint(action: string, body: { amendment?: unknown; approval?: unknown }): string | undefined {
  if (action === 'requestAmendment' && body.amendment !== undefined) return `amendment:${canonicalJson(body.amendment)}`
  if (action === 'approveAmendment' && body.approval !== undefined) return `approval:${canonicalJson(body.approval)}`
  return undefined
}

export interface PreparedRequest { id: string; proposal: BookingAmendmentProposal; changes: AmendmentChange[]; eventPayload: Record<string, Prisma.InputJsonValue> }

/** A structured request: validated against the booking as it is, and stored (status REQUESTED). A free-text request (no `amendment`) returns null and changes nothing here. */
export async function recordAmendmentRequest(tx: Tx, input: { tenantId: string; bookingId: string; userId: string; raw: unknown; now: Date }): Promise<PreparedRequest | null> {
  if (input.raw === undefined) return null
  const b = await loadAmendmentSubject(tx, input.tenantId, input.bookingId)
  if (!b) return null // the transition reports the missing booking
  const state = stateOf(b)
  const checked = validateAmendmentProposal(input.raw, state, input.now.toISOString().slice(0, 10))
  if (!checked.ok) {
    const noChange = checked.issues.length === 1 && checked.issues[0].field === '*' && /Nothing would change/.test(checked.issues[0].message)
    throw rejectIssues(noChange ? BOOKING_AMENDMENT_FAILURE.noChange : BOOKING_AMENDMENT_FAILURE.invalid, checked.issues)
  }
  refuseInventoryBacked(b, checked.changes)
  const row = await tx.bookingAmendment.create({ data: { tenantId: input.tenantId, bookingId: input.bookingId, fromVersion: b.version, proposal: checked.proposal as unknown as Prisma.InputJsonObject, beforeState: state as unknown as Prisma.InputJsonObject, requestedByUserId: input.userId }, select: { id: true } })
  return { id: row.id, proposal: checked.proposal, changes: checked.changes, eventPayload: { amendmentId: row.id, changes: checked.changes } }
}

export interface PreparedDecision {
  kind: 'APPROVE' | 'REJECT'
  amendmentId: string; subject: AmendmentSubjectRow; proposal: BookingAmendmentProposal; changes: AmendmentChange[]
  approval?: { sellMinor: bigint; netMinor: bigint | null | undefined; cancelDeadline: Date | null | undefined }
  differenceMinor?: bigint
  eventPayload: Record<string, Prisma.InputJsonValue>
}

/**
 * Judges an approve or reject against the open amendment. Returns null for a free-text request (nothing structured is open): approving it only records approval, and a body
 * that carries an approval for it is refused. `ledgerCharged` is whether the agency ledger holds an entry for this booking: `true`, `false`, or `null` when it could not be
 * read (then a price change fails closed).
 */
export async function prepareAmendmentDecision(tx: Tx, input: { tenantId: string; bookingId: string; kind: 'APPROVE' | 'REJECT'; rawApproval: unknown; ledgerCharged: boolean | null; now: Date }): Promise<PreparedDecision | null> {
  const open = await tx.bookingAmendment.findFirst({ where: { tenantId: input.tenantId, bookingId: input.bookingId, status: 'REQUESTED' }, select: { id: true, fromVersion: true, proposal: true } })
  if (!open) {
    // A price sent for a free-text request is a mistake worth naming. If the booking is no longer awaiting a decision at all (someone decided first), say nothing special:
    // the status compare-and-set answers with the usual "the booking changed" (409).
    if (input.rawApproval !== undefined) {
      const current = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId: input.tenantId }, select: { status: true } })
      if (current?.status === 'AMEND_REQUESTED') throw new BadRequestException({ message: 'There is no structured amendment to approve; a free-text request is approved without a price', code: BOOKING_AMENDMENT_FAILURE.approvalNotExpected })
    }
    return null
  }
  const subject = await loadAmendmentSubject(tx, input.tenantId, input.bookingId)
  if (!subject) return null
  if (subject.version !== open.fromVersion) throw new ConflictException({ message: 'The booking changed after this amendment was requested. Reject it and ask again.', code: BOOKING_AMENDMENT_FAILURE.stale })
  const proposal = open.proposal as unknown as BookingAmendmentProposal
  const state = stateOf(subject)

  if (input.kind === 'REJECT') {
    if (input.rawApproval !== undefined) throw new BadRequestException({ message: 'A rejection carries no price', code: BOOKING_AMENDMENT_FAILURE.approvalNotExpected })
    return { kind: 'REJECT', amendmentId: open.id, subject, proposal, changes: [], eventPayload: { amendmentId: open.id } }
  }

  if (input.rawApproval === undefined) throw new UnprocessableEntityException({ message: 'Record the price the supplier confirmed for the new dates and occupancy', code: BOOKING_AMENDMENT_FAILURE.approvalRequired })
  const approval = validateAmendmentApproval(input.rawApproval)
  if (!approval.ok) throw rejectIssues(BOOKING_AMENDMENT_FAILURE.approvalInvalid, approval.issues)
  // The proposal is judged again against the booking as it is now (it cannot have gone stale into the past, or into nothing).
  const again = validateAmendmentProposal(proposal, state, input.now.toISOString().slice(0, 10))
  if (!again.ok) throw rejectIssues(BOOKING_AMENDMENT_FAILURE.stale, again.issues)
  refuseInventoryBacked(subject, again.changes)
  const difference = BigInt(amendmentDifference(subject.totalMinor, approval.approval.sellMinor).differenceMinor)
  if (difference !== 0n) {
    if (input.ledgerCharged === true) throw new ConflictException({ message: 'This booking was charged on the agency ledger, and a price change needs a ledger adjustment that is not built yet. Reject this amendment and agree the change with Finance.', code: BOOKING_AMENDMENT_FAILURE.ledgerRequired })
    if (input.ledgerCharged === null) throw new ConflictException({ message: 'Could not check whether this booking was charged on the agency ledger, so a price change is not allowed. Try again, or ask Finance.', code: BOOKING_AMENDMENT_FAILURE.ledgerUnverifiable })
  }
  return {
    kind: 'APPROVE', amendmentId: open.id, subject, proposal, changes: again.changes, approval: approval.approval, differenceMinor: difference,
    eventPayload: { amendmentId: open.id, changes: again.changes, differenceMinor: difference.toString(), newSellMinor: approval.approval.sellMinor.toString() },
  }
}

/**
 * Applies the decision after the status move succeeded. Approve: the stay, the occupancy, the price and the deadline change together, the version was already bumped by the
 * transition, the difference is recorded as a money fact, and the amendment row records the outcome. Reject: only the amendment row changes; the booking stays exactly as it was.
 */
export async function applyAmendmentDecision(tx: Tx, input: { tenantId: string; bookingId: string; userId: string; decision: PreparedDecision; now: Date }): Promise<{ documentsNotReissued: string[] }> {
  const { tenantId, bookingId, userId, decision, now } = input
  if (decision.kind === 'REJECT') {
    await tx.bookingAmendment.updateMany({ where: { id: decision.amendmentId, tenantId, status: 'REQUESTED' }, data: { status: 'REJECTED', decidedByUserId: userId, decidedAt: now } })
    return { documentsNotReissued: [] }
  }
  const { subject, proposal, changes, approval, differenceMinor } = decision
  if (!approval || differenceMinor === undefined) throw new ConflictException({ message: 'The approval is incomplete', code: BOOKING_AMENDMENT_FAILURE.approvalRequired })
  const checkIn = proposal.checkIn ?? isoDay(subject.checkIn); const checkOut = proposal.checkOut ?? isoDay(subject.checkOut)
  const stayChanged = changes.includes('STAY_DATES')
  const money = amendedNetAndMarkup(approval.sellMinor, approval.netMinor)
  const deadline = amendedCancelDeadline(subject.cancelDeadline, changes, approval.cancelDeadline)
  const nights = stayChanged && checkIn && checkOut ? Math.round((Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86_400_000) : subject.nights

  const updated = await tx.booking.updateMany({
    where: { id: bookingId, tenantId, status: 'CONFIRMED', closedAt: null },
    data: { totalMinor: approval.sellMinor, netMinor: money.netMinor, markupMinor: money.markupMinor, cancelDeadline: deadline, ...(stayChanged ? { checkIn: new Date(`${checkIn}T00:00:00.000Z`), checkOut: new Date(`${checkOut}T00:00:00.000Z`), nights } : {}) },
  })
  if (updated.count !== 1) throw new ConflictException({ message: 'The booking changed while the amendment was being applied. Reload and try again.', code: 'STALE_STATUS' })
  // Per-room prices would no longer add up to the new total: they become unknown (null), never stale.
  await tx.bookingRoom.updateMany({ where: { tenantId, bookingId }, data: { sellMinor: null, netMinor: null } })
  for (const room of proposal.rooms ?? []) {
    await tx.bookingRoom.updateMany({ where: { tenantId, bookingId, position: room.position }, data: { adults: room.adults, children: room.children, childAges: room.childAges } })
  }
  const documents = await tx.bookingDocument.findMany({ where: { tenantId, bookingId }, select: { type: true } })
  const notReissued = [...new Set(documents.map((d) => d.type as string))].sort()
  await tx.bookingAmendment.updateMany({
    where: { id: decision.amendmentId, tenantId, status: 'REQUESTED' },
    data: { status: 'APPROVED', approvedSellMinor: approval.sellMinor, approvedNetMinor: money.netMinor, differenceMinor, approvedCancelDeadline: deadline, documentsNotReissued: notReissued, decidedByUserId: userId, decidedAt: now },
  })
  if (differenceMinor !== 0n) await emitAmendmentFinance(tx, { id: bookingId, tenantId, currency: subject.currency, totalMinor: approval.sellMinor, netMinor: money.netMinor, paymentMode: subject.paymentMode }, differenceMinor, userId, { amendmentId: decision.amendmentId })
  return { documentsNotReissued: notReissued }
}
