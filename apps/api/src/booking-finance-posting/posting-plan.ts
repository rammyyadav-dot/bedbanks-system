import type { BookingFinanceEventType, PostingReviewReason, PostingSkipReason } from '@bedbanks/contracts'
import { refundWithin } from '@bedbanks/money'

/**
 * The accounting rules of the booking Finance consumer (ADR 0076), as one pure function: a money fact in, the ledger and payable movements out. No I/O and no framework, so every
 * rule is unit-tested without a database. Integer minor units as bigint; currencies are never converted or added. The caller appends the legs through `appendLedgerEntry`
 * (ADR 0062) and the payable entry, in the same transaction as the posting row.
 *
 * Idempotency keys deliberately reuse the Agent flow's keys (`booking:<id>:authorize`, `…:settle-debit`, `…:cancel-refund`), so the two paths can never both charge, hold or refund one
 * booking: the second append is refused by the ledger's unique (wallet, key), and `CancellationSettlementService` recognises a booking charged here as ledger-charged.
 *
 * The books must also tie out under the ledger integrity monitor (ADR 0068, `checkLedgerIntegrity`), which reads the Agent flow's lifecycle: every charge is HOLD, then RELEASE (`…:settle-release`)
 * plus DEBIT of the same amount, all on reference `booking:<id>`, summing to the booking total; a cancelled charged booking has a `Cancellation` record whose refund equals the REFUND entries.
 * So a confirmation that had no on-request hold posts the whole lifecycle (net effect: minus the sell price), a refund also fixes the `Cancellation` record, and an amendment is never posted as
 * a separate entry (see `AMENDED`).
 */
export type PaymentMode = 'CREDIT' | 'PREPAID' | 'PAY_AT_HOTEL'
export type LedgerLegType = 'HOLD' | 'RELEASE' | 'DEBIT' | 'REFUND'
export type PayableKind = 'ACCRUAL' | 'ADJUSTMENT' | 'REVERSAL'

export interface PostingEvent {
  id: string
  type: BookingFinanceEventType
  seq: number
  currency: string
  sellMinor: bigint
  netMinor: bigint | null
  penaltyMinor: bigint | null
  refundMinor: bigint | null
  adjustmentMinor: bigint | null
  paymentMode: PaymentMode | null
}

/** What the ledger and the payable entries already say about this booking, read by the caller inside the posting transaction. */
export interface PostingFacts {
  bookingId: string
  /** The agency that made the booking, null when it cannot be derived. */
  agencyId: string | null
  /** The supplier organization that owns the booking, null for connector, manual and historical bookings. */
  supplierId: string | null
  /** The wallet of (agency, event currency), null when the account is not open. */
  walletId: string | null
  /** The positive amount held on the account for this booking, null when no hold was posted. */
  heldMinor: bigint | null
  holdReleased: boolean
  /** The positive amount debited at confirmation (`…:settle-debit`), null when the booking was not charged. */
  chargedMinor: bigint | null
  /** The refund the booking's `Cancellation` record fixed, null when it has no record. */
  cancellationRefundMinor: bigint | null
  /** The AMENDED events of this booking recorded after this one, in order (their sell and net are the booking's totals from then on). */
  laterAmendments: ReadonlyArray<{ sellMinor: bigint; netMinor: bigint | null }>
  /** Cancellation refunds already posted (sum of REFUND on `booking:<id>`). */
  refundedMinor: bigint
  /** Sum of the booking's payable entries. */
  payableMinor: bigint
  /** A CANCELLED event of this booking exists earlier than this event. */
  cancelledBefore: boolean
}

export interface LedgerLeg { type: LedgerLegType; amountMinor: bigint; reference: string; idempotencyKey: string }
export interface PayableLeg { kind: PayableKind; amountMinor: bigint }

export type PostingPlan =
  | { kind: 'POST'; legs: LedgerLeg[]; payable: PayableLeg | null; cancellationRefundMinor: bigint | null; notes: string[] }
  | { kind: 'SKIP'; reason: SkipReason }
  | { kind: 'REVIEW'; reason: ReviewReason }

/** Final: the event moves no money (or the money was already moved by the Agent flow). Not final: a person or an owner step must fix something, then the event is retried; nothing was posted. The codes live in @bedbanks/contracts. */
export type SkipReason = PostingSkipReason
export type ReviewReason = PostingReviewReason

export const holdKey = (bookingId: string) => `booking:${bookingId}:authorize`
export const releaseKey = (bookingId: string) => `${holdKey(bookingId)}:release`
export const settleReleaseKey = (bookingId: string) => `${holdKey(bookingId)}:settle-release`
export const settleDebitKey = (bookingId: string) => `${holdKey(bookingId)}:settle-debit`
export const refundKey = (bookingId: string, targetMinor: bigint, alreadyRefundedMinor: bigint) => alreadyRefundedMinor === 0n ? `booking:${bookingId}:cancel-refund` : `booking:${bookingId}:cancel-refund:${targetMinor}`
export const bookingReference = (bookingId: string) => `booking:${bookingId}`

const post = (legs: LedgerLeg[], payable: PayableLeg | null = null, notes: string[] = [], cancellationRefundMinor: bigint | null = null): PostingPlan => ({ kind: 'POST', legs, payable, cancellationRefundMinor, notes })
const skip = (reason: SkipReason): PostingPlan => ({ kind: 'SKIP', reason })
const review = (reason: ReviewReason): PostingPlan => ({ kind: 'REVIEW', reason })

/**
 * Pre-conditions every event needs before any rule runs. The order matters: what the operator must decide (payment mode) comes before what Finance must set up (agency, account).
 * A pay-at-hotel booking moves no money through us: the guest pays the hotel, so there is neither an agency charge nor a supplier payable.
 */
function gate(event: PostingEvent, facts: PostingFacts): PostingPlan | null {
  if (event.paymentMode === null) return review('PAYMENT_MODE_UNKNOWN')
  if (event.paymentMode === 'PAY_AT_HOTEL') return skip('PAY_AT_HOTEL')
  if (facts.agencyId === null) return review('NO_AGENCY')
  return null
}

export function planPosting(event: PostingEvent, facts: PostingFacts): PostingPlan {
  const early = gate(event, facts)
  if (early) return early
  // Every rule below that appends to the agency account needs it open. Opening an account is a funding decision (ADR 0028), never made here.
  const needsWallet = (legs: LedgerLeg[]) => legs.length > 0 && facts.walletId === null
  const ref = bookingReference(facts.bookingId)

  switch (event.type) {
    case 'CONFIRMED': {
      if (facts.chargedMinor !== null) return skip('ALREADY_CHARGED_ON_LEDGER')
      // An amendment recorded before this confirmation was posted changed the booking's totals: the booking is charged what it is worth now, once, and the amendment is then reflected.
      const latest = facts.laterAmendments.length > 0 ? facts.laterAmendments[facts.laterAmendments.length - 1] : null
      const sell = latest ? latest.sellMinor : event.sellMinor
      const net = latest ? latest.netMinor : event.netMinor
      // A hold taken for another amount is not converted silently: the settlement would leave a part reserved or charge a part unreserved.
      if (facts.heldMinor !== null && !facts.holdReleased && facts.heldMinor !== sell) return review('HOLD_AMOUNT_DIFFERS')
      const legs: LedgerLeg[] = []
      if (sell > 0n) {
        // The Agent lifecycle is HOLD, then RELEASE and DEBIT of the same amount. A booking confirmed without an on-request hold gets the whole lifecycle, net effect minus the sell price.
        if (facts.heldMinor === null) legs.push({ type: 'HOLD', amountMinor: -sell, reference: ref, idempotencyKey: holdKey(facts.bookingId) })
        if (facts.heldMinor === null || !facts.holdReleased) legs.push({ type: 'RELEASE', amountMinor: sell, reference: ref, idempotencyKey: settleReleaseKey(facts.bookingId) })
        legs.push({ type: 'DEBIT', amountMinor: -sell, reference: ref, idempotencyKey: settleDebitKey(facts.bookingId) })
      }
      if (needsWallet(legs)) return review('NO_WALLET')
      if (net === null) return review('NET_UNKNOWN')
      let payable: PayableLeg | null = null
      if (net > 0n) {
        if (facts.supplierId === null) return review('NO_SUPPLIER')
        payable = { kind: 'ACCRUAL', amountMinor: net }
      }
      if (legs.length === 0 && payable === null) return skip('ZERO_SELL')
      return post(legs, payable, latest ? ['INCLUDES_LATER_AMENDMENT'] : [])
    }

    case 'ON_REQUEST_HOLD': {
      if (event.sellMinor <= 0n) return skip('ZERO_SELL')
      if (facts.heldMinor !== null) return skip('HOLD_ALREADY_POSTED')
      if (facts.chargedMinor !== null) return skip('ALREADY_CHARGED_ON_LEDGER')
      if (facts.walletId === null) return review('NO_WALLET')
      return post([{ type: 'HOLD', amountMinor: -event.sellMinor, reference: ref, idempotencyKey: holdKey(facts.bookingId) }])
    }

    case 'HOLD_RELEASED': {
      if (facts.heldMinor === null) return skip('NO_HOLD_ON_LEDGER')
      if (facts.holdReleased) return skip('HOLD_ALREADY_RELEASED')
      return post([{ type: 'RELEASE', amountMinor: facts.heldMinor, reference: ref, idempotencyKey: releaseKey(facts.bookingId) }])
    }

    case 'CANCELLED':
    case 'PENALTY_DECIDED':
    case 'PENALTY_WAIVED': {
      if (event.type !== 'CANCELLED' && !facts.cancelledBefore) return skip('AWAITS_CANCELLATION')
      // A cancellation recorded with no determined penalty carries null amounts: money is never guessed. A later decision or waiver carries them.
      if (event.penaltyMinor === null || event.refundMinor === null) return skip('PENALTY_UNDETERMINED')
      if (event.penaltyMinor + event.refundMinor !== event.sellMinor) return review('EVENT_INCONSISTENT')
      const payable = cancellationPayable(event, facts)
      const notes = event.penaltyMinor > 0n ? ['SUPPLIER_LEG_AWAITS_STATEMENT'] : []
      if (facts.chargedMinor === null) return payable ? post([], payable, notes) : skip('NOT_CHARGED_ON_LEDGER')
      const target = event.refundMinor
      const charged = facts.chargedMinor
      if (!refundWithin({ refundMinor: target, authorizedRefundableMinor: charged })) return review('REFUND_EXCEEDS_CHARGE')
      // A refund is never taken back automatically: a decision that would refund less than already posted needs a person.
      if (target < facts.refundedMinor) return review('REFUND_WOULD_DECREASE')
      const delta = target - facts.refundedMinor
      const legs: LedgerLeg[] = delta > 0n ? [{ type: 'REFUND', amountMinor: delta, reference: ref, idempotencyKey: refundKey(facts.bookingId, target, facts.refundedMinor) }] : []
      if (needsWallet(legs)) return review('NO_WALLET')
      // The integrity monitor ties a cancelled, charged booking to its Cancellation record: write it (also for a refund of zero) or bring it to the refund now decided.
      const recordNeeded = facts.cancellationRefundMinor !== target
      if (legs.length === 0 && payable === null && !recordNeeded) return skip('NOTHING_TO_ADD')
      return post(legs, payable, notes, recordNeeded ? target : null)
    }

    case 'AMENDED': {
      if (event.adjustmentMinor === null || event.adjustmentMinor === 0n) return review('EVENT_INCONSISTENT')
      if (facts.chargedMinor === null) return skip('NOT_CHARGED_ON_LEDGER')
      // The ledger holds one charge per booking and the integrity monitor ties it to the booking total, so an amendment is never a separate entry (ADR 0072 refuses a price change on a
      // booking already charged for the same reason). If the charge already equals the total this amendment or a later one set, it was folded into the confirmation; otherwise it is a
      // Finance decision, and it stays in review where the integrity monitor will also show the difference.
      const totals = [event.sellMinor, ...facts.laterAmendments.map((a) => a.sellMinor)]
      if (totals.includes(facts.chargedMinor)) return skip('AMENDMENT_ALREADY_REFLECTED')
      return review('AMENDMENT_NEEDS_LEDGER_ADJUSTMENT')
    }
  }
}

/**
 * When the supplier owes nothing for a cancelled booking, the accrual is reversed. With a penalty the supplier may charge its own fee, which this event does not state (its penalty
 * is the sell-side penalty), so the accrual stays until the supplier's statement is reconciled (ADR 0070). That is the default; the owner may change it (ADR 0076).
 */
function cancellationPayable(event: PostingEvent, facts: PostingFacts): PayableLeg | null {
  if (event.penaltyMinor !== 0n || facts.payableMinor <= 0n) return null
  return { kind: 'REVERSAL', amountMinor: -facts.payableMinor }
}

/** The net effect of the legs on the account balance, signed. HOLD and DEBIT lower it; RELEASE and REFUND raise it. A hold plus its release nets to zero. */
export const agencyEffect = (legs: readonly LedgerLeg[]): bigint => legs.reduce((sum, leg) => sum + leg.amountMinor, 0n)

/** What the legs charged the agency (positive: the DEBIT legs). A hold and its release are not sales. */
export const salesOf = (legs: readonly LedgerLeg[]): bigint => legs.reduce((sum, leg) => (leg.type === 'DEBIT' ? sum - leg.amountMinor : sum), 0n)
/** What the legs refunded the agency (positive: the REFUND legs). */
export const refundsOf = (legs: readonly LedgerLeg[]): bigint => legs.reduce((sum, leg) => (leg.type === 'REFUND' ? sum + leg.amountMinor : sum), 0n)
