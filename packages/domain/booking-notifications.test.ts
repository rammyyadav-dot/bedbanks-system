import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMinorUnits } from '@bedbanks/money'
import {
  NotificationRejected,
  acknowledgmentDeadlineMs,
  classifyDeliveryFailure,
  evaluateAutoRelease,
  formatTimeRemaining,
  nextDocumentVersion,
  prepareScheduledReminder,
  renderAgentBookingConfirmation,
  renderAgentDeadlineReminder,
  renderBookingNotification,
  renderDeadlineOutcome,
  renderHotelSupplierLpo,
  renderInternalAuditDigest,
  renderServiceVoucher,
  renderSupplierConfirmationRecorded,
  renderSupplierReminder,
  resolveCancellationRequest,
  supplierConfirmationDecision,
  validateNotificationSchedule,
  voucherIssuancePermitted,
  type AgentBookingConfirmationInput,
  type AgentDeadlineReminderInput,
  type DeadlineOutcomeInput,
  type HotelSupplierLpoInput,
  type InternalAuditDigestInput,
  type ServiceVoucherInput,
  type SupplierConfirmationRecordedInput,
  type SupplierReminderInput,
} from './src/booking-notifications.ts'

const AED = (amountMinor: number) => ({ amountMinor, currency: 'AED' })
const WHEN = '2026-11-01 09:00 Asia/Dubai'
const OPS = { email: 'ops@fbed.example', phone: '+971 4 123 4567' }
const moneyText = (amountMinor: number) => formatMinorUnits(amountMinor, 'AED')

function rejects(run: () => void, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof NotificationRejected && error.code === code)
}

function lpo(overrides: Partial<HotelSupplierLpoInput> = {}): HotelSupplierLpoInput {
  return {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'lpo-v1', recipientRef: 'supplier-ops' },
    supplierName: 'Marina Contracted Hotel',
    hotelName: 'Marina Contracted Hotel',
    hotelAddress: '1 Marina Walk, Dubai',
    lpoId: 'LPO1',
    version: 1,
    changeSummary: null,
    bookingStatus: 'Awaiting Supplier Confirmation',
    explicitAcceptance: false,
    contractualGuarantee: false,
    contractReference: 'CTR-44',
    issuedAt: WHEN,
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    nights: 2,
    leadGuest: 'Amina Rahman',
    additionalGuests: ['Yusuf Rahman'],
    adults: 2,
    children: 0,
    childAges: [],
    roomCategory: 'Deluxe King',
    roomCount: 1,
    occupancy: '2 adults, 1 king bed',
    mealPlan: 'BB',
    specialRequests: [],
    currency: 'AED',
    rateBasis: 'Per Room Per Night',
    nightlyRates: [{ description: '2026-11-10 to 2026-11-12', amount: AED(80000) }],
    roomSubtotal: AED(80000),
    taxes: [{ description: 'Tourism fee', amount: AED(10000) }],
    extras: [{ description: 'Extra bed', amount: AED(5000) }],
    total: AED(95000),
    payableLocally: [{ description: 'Tourism Dirham', amount: AED(2000) }],
    settlementTerms: 'Contracted credit account, 30 days',
    cancellationTerms: 'Free until the cancellation deadline, then 100 percent.',
    cancellationDeadline: '2026-11-08 15:00 Asia/Dubai',
    noShowTerms: '100 percent of the contracted stay.',
    optionExpiry: null,
    acknowledgmentDeadline: '2026-11-01 13:00 Asia/Dubai',
    operations: OPS,
    ...overrides,
  }
}

test('LPO uses contracted procurement values and leaves no placeholders', () => {
  const mail = renderHotelSupplierLpo(lpo())
  assert.equal(mail.audience, 'HOTEL_SUPPLIER')
  assert.equal(mail.templateVersion, '2026-11-03')
  assert.equal(mail.subject, '[LPO][ACTION REQUIRED] LPO1 | Marina Contracted Hotel | 2026-11-10 | BK1')
  assert.match(mail.text, /CONTRACTED PROCUREMENT VALUE/)
  assert.match(mail.text, new RegExp(`Nightly Rate Breakdown: 2026-11-10 to 2026-11-12: Net Rate ${moneyText(80000)}`))
  assert.match(mail.text, new RegExp(`Total LPO Value: ${moneyText(95000)}`))
  assert.match(mail.text, /Child Ages at Check-in: Not Applicable/)
  assert.match(mail.text, /Special Requests: None/)
  assert.match(mail.text, /Supplier Option Expiry, if applicable: Not Applicable/)
  assert.equal(mail.text.includes('Agent Commission'), false)
  assert.equal(mail.text.includes('['), false)
  assert.equal(mail.notificationKey, 'bkn/1/2026-11-03/ten1/BK1/HOTEL_SUPPLIER_LPO/lpo-v1/supplier-ops')
})

test('an amended LPO invalidates the previous version and a mismatched total is refused', () => {
  const amended = renderHotelSupplierLpo(lpo({ version: 2, changeSummary: 'Meal plan corrected to BB.', identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'lpo-v2', recipientRef: 'supplier-ops' } }))
  assert.match(amended.text, /This LPO version 2 replaces version 1\. Earlier versions are invalid\./)
  rejects(() => renderHotelSupplierLpo(lpo({ total: AED(100) })), 'MONEY_MISMATCH:total')
  rejects(() => renderHotelSupplierLpo(lpo({ hotelName: 'Hotel [unconfirmed]' })), 'INVALID_TEXT:hotelName')
  rejects(() => renderHotelSupplierLpo(lpo({ settlementTerms: 'Use the card number on file' })), 'CREDENTIAL_LIKE_TEXT:settlementTerms')
  rejects(() => renderHotelSupplierLpo(lpo({ bookingStatus: 'Confirmed' })), 'STATUS_CONFLICT:bookingStatus')
})

test('supplier acknowledgment does not confirm, and a contractual guarantee can', () => {
  assert.deepEqual(supplierConfirmationDecision({ acknowledged: true, explicitAcceptance: false, contractualGuarantee: false }), { markConfirmed: false, acknowledgmentIsReceiptOnly: true })
  assert.equal(supplierConfirmationDecision({ acknowledged: false, explicitAcceptance: false, contractualGuarantee: true }).markConfirmed, true)
  assert.equal(resolveCancellationRequest({ requested: true, supplierConfirmed: false }), 'PENDING')
  assert.equal(resolveCancellationRequest({ requested: true, supplierConfirmed: true }), 'CONFIRMED')
  rejects(() => resolveCancellationRequest({ requested: false, supplierConfirmed: true }), 'STATUS_CONFLICT:cancellation')
})

test('supplier reminder and recorded confirmation stay on the procurement side', () => {
  const reminder: SupplierReminderInput = {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'supplier-reminder-1', recipientRef: 'supplier-ops' },
    supplierName: 'Marina Contracted Hotel', hotelName: 'Marina Contracted Hotel', lpoId: 'LPO1', version: 1,
    leadGuest: 'Amina Rahman', checkIn: '2026-11-10', checkOut: '2026-11-12', roomCount: 1, roomCategory: 'Deluxe King',
    dispatchedAt: WHEN, responseDeadline: '2026-11-01 13:00 Asia/Dubai', reminderNumber: 1, escalationDeadline: '2026-11-01 18:00 Asia/Dubai',
    currentBookingStatus: 'Awaiting Supplier Confirmation', supplierConfirmed: false, cancelled: false, superseded: false, operations: OPS,
  }
  const overdue = renderSupplierReminder(reminder)
  assert.match(overdue.subject, /^\[URGENT\]\[CONFIRMATION OVERDUE\] BK1 \|/)
  assert.match(overdue.text, /Reminder Number: 1/)
  rejects(() => renderSupplierReminder({ ...reminder, supplierConfirmed: true }), 'REMINDER_NOT_DUE')

  const recorded: SupplierConfirmationRecordedInput = {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'supplier-confirmed', recipientRef: 'supplier-ops' },
    supplierName: 'Marina Contracted Hotel', hotelName: 'Marina Contracted Hotel', lpoId: 'LPO1', version: 1,
    leadGuest: 'Amina Rahman', checkIn: '2026-11-10', checkOut: '2026-11-12', roomDetails: '1 x Deluxe King', mealPlan: 'BB',
    supplierConfirmationNumber: 'SUP-77', hotelConfirmationNumber: null, procurementTotal: AED(95000), confirmedAt: '2026-11-01 14:00 Asia/Dubai',
    explicitAcceptance: true, contractualGuarantee: false, operations: OPS,
  }
  const confirmation = renderSupplierConfirmationRecorded(recorded)
  assert.equal(confirmation.subject, '[CONFIRMATION RECORDED] BK1 | Supplier Ref SUP-77')
  assert.match(confirmation.text, /Hotel Confirmation Number: Awaited/)
  assert.match(confirmation.text, new RegExp(`Confirmed Procurement Total: ${moneyText(95000)}`))
  assert.equal(confirmation.text.includes('Agent Commission'), false)
  rejects(() => renderSupplierConfirmationRecorded({ ...recorded, explicitAcceptance: false }), 'STATUS_CONFLICT:bookingStatus')
})

function agentConfirmation(overrides: Partial<AgentBookingConfirmationInput> = {}): AgentBookingConfirmationInput {
  return {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'agent-confirmed', recipientRef: 'agent-user-9' },
    supplierConfirmed: true,
    agentContactName: 'Priya Shah',
    agencyName: 'Shah Travel',
    confirmationReference: 'HTL-99',
    leadGuest: 'Amina Rahman',
    additionalGuests: [],
    hotelName: 'Marina Contracted Hotel',
    checkIn: '2026-11-10',
    checkOut: '2026-11-12',
    nights: 2,
    rooms: '1 x Deluxe King',
    occupancy: '2 adults',
    mealPlan: 'BB',
    specialRequests: 'Late arrival, subject to availability',
    commercial: { currency: 'AED', accommodation: AED(100000), taxes: AED(10000), commission: AED(10000), commissionTreatment: 'Deductible', cleared: AED(40000) },
    paymentLabel: 'PART PAID',
    paymentDue: '2026-11-05 18:00 Asia/Dubai',
    optionExpiry: null,
    cancellationDeadline: '2026-11-08 15:00 Asia/Dubai',
    cancellationTerms: 'Free until the deadline, then the full stay.',
    autoReleaseRule: null,
    voucherReference: null,
    voucherStatus: 'Pending Payment',
    paymentCleared: false,
    creditApproved: false,
    deadlineWarning: 'Payment remains outstanding.',
    support: { email: 'agents@fbed.example', phone: '+971 4 123 4567' },
    ...overrides,
  }
}

test('agent confirmation shows commission and payable balance, not the net rate', () => {
  const mail = renderAgentBookingConfirmation(agentConfirmation())
  assert.equal(mail.subject, '[BOOKING CONFIRMED][PAYMENT: PART PAID] BK1 | Marina Contracted Hotel')
  assert.match(mail.text, new RegExp(`Total Before Commission: ${moneyText(110000)}`))
  assert.match(mail.text, new RegExp(`Agent Commission: ${moneyText(10000)}`))
  assert.match(mail.text, /Commission Treatment: Deductible/)
  assert.match(mail.text, new RegExp(`Total Payable to fBed: ${moneyText(100000)}`))
  assert.match(mail.text, new RegExp(`Outstanding Balance: ${moneyText(60000)}`))
  assert.match(mail.text, /Voucher Reference: Pending Issuance/)
  assert.equal(mail.text.includes('Net Rate'), false)
  assert.equal(mail.text.includes('Total LPO Value'), false)
  const separate = renderAgentBookingConfirmation(agentConfirmation({ commercial: { currency: 'AED', accommodation: AED(100000), taxes: AED(10000), commission: AED(5000), commissionTreatment: 'Paid Separately', cleared: AED(0) } }))
  assert.match(separate.text, new RegExp(`Total Payable to fBed: ${moneyText(110000)}`))
  rejects(() => renderAgentBookingConfirmation(agentConfirmation({ supplierConfirmed: false })), 'STATUS_CONFLICT:supplierConfirmed')
})

test('payment reminder is refused once payment, credit, cancellation or the deadline has moved on', () => {
  const reminder: AgentDeadlineReminderInput = {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'pay-warning-24h', recipientRef: 'agent-user-9' },
    focus: 'PAYMENT DUE', agentContactName: 'Priya Shah', hotelName: 'Marina Contracted Hotel', leadGuest: 'Amina Rahman',
    checkIn: '2026-11-10', checkOut: '2026-11-12', outstanding: AED(60000), paymentDeadline: '2026-11-05 18:00 Asia/Dubai',
    optionExpiry: null, releaseDeadline: '2026-11-05 18:00 Asia/Dubai', timeRemaining: formatTimeRemaining(2 * 60 * 60 * 1000 + 15 * 60 * 1000),
    requiredAction: 'Complete Payment', paymentInstructions: 'Approved bank instruction REF-19', approvedChannel: 'the agent portal payment page',
    autoReleaseWarning: 'The booking may be released if payment is not cleared.', cancellationCharges: 'Charges follow the confirmed cancellation terms.',
    paymentCleared: false, creditApproved: false, cancelled: false, superseded: false, deadlinePassed: false,
    support: { email: 'accounts@fbed.example', phone: '+971 4 123 4567' },
  }
  const mail = renderAgentDeadlineReminder(reminder)
  assert.equal(mail.subject, '[ACTION REQUIRED][PAYMENT DUE] BK1 | Deadline 2026-11-05 18:00 Asia/Dubai')
  assert.match(mail.text, /Time Remaining: 2 hours 15 minutes/)
  assert.match(mail.text, /A remittance receipt alone does not establish cleared payment/)
  rejects(() => renderAgentDeadlineReminder({ ...reminder, paymentCleared: true }), 'REMINDER_NOT_DUE')
  rejects(() => renderBookingNotification({ template: 'AGENT_DEADLINE_REMINDER', input: { ...reminder, focus: 'OPTION EXPIRING' } }), 'EMPTY_FIELD:optionExpiry')
})

test('release email is rendered only after the auto-release checks pass', () => {
  assert.deepEqual(evaluateAutoRelease({ termsPermitAutoRelease: true, deadlinePassed: true, paymentCleared: true, creditApproved: false, extensionAuthorized: false }), { release: false, reason: 'PAYMENT_CLEARED' })
  assert.equal(evaluateAutoRelease({ termsPermitAutoRelease: false, deadlinePassed: true, paymentCleared: false, creditApproved: false, extensionAuthorized: false }).reason, 'TERMS_DO_NOT_PERMIT')
  const outcome: DeadlineOutcomeInput = {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'released', recipientRef: 'agent-user-9' },
    outcome: 'BOOKING RELEASED', agentContactName: 'Priya Shah', hotelName: 'Marina Contracted Hotel', leadGuest: 'Amina Rahman',
    deadline: '2026-11-05 18:00 Asia/Dubai', deadlinePassed: true, currentStatus: 'Released', actionCompleted: 'Inventory released',
    supplierCancellationReference: 'Not Applicable', charges: { kind: 'UNDER_REVIEW' }, refundStatus: 'Not Applicable',
    explanation: 'The option expired without cleared payment or approved credit.', supportContact: 'Agent Support',
    support: OPS, release: { termsPermitAutoRelease: true, paymentCleared: false, creditApproved: false, extensionAuthorized: false },
    cancellationRequested: false, supplierConfirmedCancellation: false,
  }
  const mail = renderDeadlineOutcome(outcome)
  assert.equal(mail.subject, '[BOOKING RELEASED] BK1')
  assert.match(mail.text, /Applicable Charges: Under Review/)
  rejects(() => renderDeadlineOutcome({ ...outcome, release: { termsPermitAutoRelease: true, paymentCleared: true, creditApproved: false, extensionAuthorized: false } }), 'STATUS_CONFLICT:PAYMENT_CLEARED')
  rejects(() => renderDeadlineOutcome({ ...outcome, outcome: 'BOOKING CANCELLED', release: null, cancellationRequested: true, supplierConfirmedCancellation: false }), 'STATUS_CONFLICT:cancellation')
  const cancelled = renderDeadlineOutcome({ ...outcome, outcome: 'BOOKING CANCELLED', release: null, cancellationRequested: true, supplierConfirmedCancellation: true, supplierCancellationReference: 'CXL-5', charges: { kind: 'AMOUNT', amount: AED(95000) }, identity: { ...outcome.identity, event: 'cancelled' } })
  assert.equal(cancelled.subject, '[BOOKING CANCELLED] BK1')
  assert.match(cancelled.text, new RegExp(`Applicable Charges: ${moneyText(95000)}`))
})

test('voucher excludes procurement and commission and requires cleared payment or credit', () => {
  assert.equal(voucherIssuancePermitted({ supplierConfirmed: true, paymentCleared: false, creditApproved: false }), false)
  assert.equal(voucherIssuancePermitted({ supplierConfirmed: true, paymentCleared: false, creditApproved: true }), true)
  const voucher: ServiceVoucherInput = {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'voucher-v1', recipientRef: 'agent-user-9' },
    supplierConfirmed: true, paymentCleared: true, creditApproved: false, agentContactName: 'Priya Shah', voucherReference: 'VCH1', version: 1, changeSummary: null,
    hotelConfirmationNumber: 'HTL-99', issuedAt: '2026-11-02 11:00 Asia/Dubai', leadGuest: 'Amina Rahman', additionalGuests: [], adults: 2, children: 1, childAges: [7],
    hotelName: 'Marina Contracted Hotel', hotelAddress: '1 Marina Walk, Dubai', hotelPhone: '+971 4 123 4567', checkIn: '2026-11-10', checkOut: '2026-11-12', nights: 2,
    roomCategory: 'Deluxe King', roomCount: 1, occupancy: '2 adults, 1 child, king bed', mealPlan: 'BB', inclusions: ['Breakfast'],
    payableAtProperty: [{ description: 'Tourism Dirham', amount: AED(2000) }], payableCurrency: 'AED', checkInTime: '15:00', checkOutTime: '12:00', hotelTimeZone: 'Asia/Dubai',
    identification: 'Passport or government photo identification.', depositPolicy: 'Hotel may request an incidental guarantee.', lateArrival: 'Advise the hotel of arrival after 21:00.',
    earlyLate: 'Subject to availability', specialRequests: 'Subject to availability', support: { email: 'agents@fbed.example', phone: '+971 4 123 4567' },
    emergencyPhone: '+971 50 000 0000', supportHours: '24 hours Asia/Dubai',
  }
  const mail = renderServiceVoucher(voucher)
  assert.equal(mail.subject, '[VOUCHER ISSUED] VCH1 | BK1 | Marina Contracted Hotel')
  assert.match(mail.text, /OFFICIAL ACCOMMODATION SERVICE VOUCHER/)
  assert.equal(mail.text.includes('Child Ages'), false)
  assert.match(mail.text, new RegExp(`Tourism Dirham: ${moneyText(2000)}`))
  assert.equal(mail.text.includes('Agent Commission'), false)
  assert.equal(mail.text.includes('Net Rate'), false)
  assert.equal(mail.text.includes('Approved Credit'), false)
  rejects(() => renderServiceVoucher({ ...voucher, paymentCleared: false }), 'STATUS_CONFLICT:voucher')
  rejects(() => renderServiceVoucher({ ...voucher, childAges: [] }), 'STATUS_CONFLICT:childAges')
  const revised = nextDocumentVersion({ previousVersion: 1, amendmentApproved: true })
  assert.deepEqual(revised, { invalidatePrevious: true, nextVersion: 2 })
  const reissued = renderServiceVoucher({ ...voucher, version: revised.nextVersion, changeSummary: 'Guest name spelling corrected.', identity: { ...voucher.identity, event: 'voucher-v2' } })
  assert.match(reissued.text, /Earlier versions are invalid/)
})

test('internal digest keeps booking, supplier, payment and voucher state apart and computes margin once', () => {
  const digest: InternalAuditDigestInput = {
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'payment-status', recipientRef: 'accounts-digest' },
    eventId: 'evt1', eventType: 'PAYMENT_STATUS', eventAt: '2026-11-02 12:00 Asia/Dubai', agencyId: 'ag1', source: 'Agent Portal', actorId: 'user9', correlationId: 'corr1',
    reason: 'Receipt matched to ledger REF-19', bookingStatus: { previous: 'CONFIRMED', current: 'CONFIRMED' }, supplierStatus: { previous: 'CONFIRMED', current: 'CONFIRMED' },
    paymentStatus: { previous: 'UNPAID', current: 'PAID' }, voucherStatus: { previous: 'PENDING', current: 'ISSUED' }, hotelName: 'Marina Contracted Hotel', supplierName: 'Marina Contracted Hotel',
    checkIn: '2026-11-10', checkOut: '2026-11-12', roomCount: 1, nightCount: 2, lpoId: 'LPO1', lpoVersion: 1, supplierConfirmationNumber: 'SUP-77', voucherReference: 'VCH1', voucherVersion: 1,
    procurementTotal: AED(95000), agentBillingTotal: AED(110000), commission: AED(10000), commissionTreatment: 'Deductible', cleared: AED(110000), approvedCredit: AED(0), outstanding: AED(0),
    supplierPaid: AED(0), supplierPayable: AED(95000), refundLiability: AED(0),
    reporting: { currency: 'AED', revenue: AED(110000), procurement: AED(95000), commission: AED(10000), directCosts: AED(0), fxRate: '1', fxSource: 'same currency', fxAsOf: '2026-11-02 12:00 Asia/Dubai' },
    notificationType: 'SERVICE_VOUCHER', recipientGroup: 'Accounts', dispatchStatus: 'Queued', providerMessageId: 'Not assigned', dispatchedAt: '2026-11-02 12:05 Asia/Dubai', retryCount: 0,
    ledgerReference: 'LED-19', supplierInvoiceReference: 'Awaited', reconciliationStatus: 'Matched', exception: null, owner: 'Accounts', nextAction: null, nextDeadline: null, auditRecord: 'audit:evt1',
  }
  const mail = renderInternalAuditDigest(digest)
  assert.equal(mail.subject, '[INTERNAL][PAYMENT_STATUS] BK1 | CONFIRMED -> CONFIRMED')
  assert.match(mail.text, /Booking Status: CONFIRMED -> CONFIRMED/)
  assert.match(mail.text, /Payment Status: UNPAID -> PAID/)
  assert.match(mail.text, /Voucher Status: PENDING -> ISSUED/)
  assert.match(mail.text, new RegExp(`Expected Gross Margin: ${moneyText(5000)}`))
  assert.match(mail.text, /without Double Counting/)
  assert.match(mail.text, /Internal use only/)
  rejects(() => renderInternalAuditDigest({ ...digest, outstanding: AED(1) }), 'MONEY_MISMATCH:outstanding')
  rejects(() => renderInternalAuditDigest({ ...digest, reporting: { ...digest.reporting, procurement: AED(1000) } }), 'MONEY_MISMATCH:reporting.procurement')
})

test('direct costs reduce the reported margin and are not added twice', () => {
  const base = renderInternalAuditDigest({
    identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'margin', recipientRef: 'accounts-digest' },
    eventId: 'evt2', eventType: 'BOOKING_STATUS', eventAt: WHEN, agencyId: 'ag1', source: 'Scheduled Job', actorId: 'job1', correlationId: 'corr2',
    reason: 'Night audit', bookingStatus: { previous: 'CONFIRMED', current: 'CHECKED_OUT' }, supplierStatus: { previous: 'CONFIRMED', current: 'CONFIRMED' },
    paymentStatus: { previous: 'PAID', current: 'PAID' }, voucherStatus: { previous: 'ISSUED', current: 'ISSUED' }, hotelName: 'Marina Contracted Hotel', supplierName: 'Marina Contracted Hotel',
    checkIn: '2026-11-10', checkOut: '2026-11-12', roomCount: 1, nightCount: 2, lpoId: 'LPO1', lpoVersion: 1, supplierConfirmationNumber: 'SUP-77', voucherReference: 'VCH1', voucherVersion: 1,
    procurementTotal: AED(95000), agentBillingTotal: AED(110000), commission: AED(10000), commissionTreatment: 'Deductible', cleared: AED(110000), approvedCredit: AED(0), outstanding: AED(0),
    supplierPaid: AED(95000), supplierPayable: AED(0), refundLiability: AED(0),
    reporting: { currency: 'AED', revenue: AED(110000), procurement: AED(95000), commission: AED(10000), directCosts: AED(1500), fxRate: '1', fxSource: 'same currency', fxAsOf: WHEN },
    notificationType: 'INTERNAL_AUDIT_DIGEST', recipientGroup: 'Accounts', dispatchStatus: 'Delivered', providerMessageId: 'msg-1', dispatchedAt: WHEN, retryCount: 1,
    ledgerReference: 'LED-19', supplierInvoiceReference: 'INV-8', reconciliationStatus: 'Matched', exception: null, owner: 'Accounts', nextAction: null, nextDeadline: null, auditRecord: 'audit:evt2',
  })
  assert.match(base.text, new RegExp(`Expected Gross Margin: ${moneyText(3500)}`))
})

test('dispatch controls recheck deadlines and keep one key per recipient', () => {
  const sla = 4 * 60 * 60 * 1000
  assert.equal(acknowledgmentDeadlineMs(1_700_000_000_000, sla), 1_700_000_000_000 + sla)
  const schedule = validateNotificationSchedule({
    supplierAcknowledgmentSlaMs: sla,
    supplierEscalationThresholdMs: sla * 2,
    agentPaymentWarningBeforeDeadlineMs: [72 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
    supplierOptionWarningBeforeExpiryMs: [48 * 60 * 60 * 1000],
    finalReminderBeforeDeadlineMs: 2 * 60 * 60 * 1000,
    operationsEscalationOwner: 'Supplier Operations',
  })
  assert.equal(schedule.agentPaymentWarningBeforeDeadlineMs.length, 2)
  rejects(() => validateNotificationSchedule({ ...schedule, supplierEscalationThresholdMs: sla - 1 }), 'INVALID_SCHEDULE:supplierEscalationThreshold')
  const deadline = 5_000_000
  assert.equal(prepareScheduledReminder({ kind: 'SUPPLIER_CONFIRMATION', nowMs: deadline - 1, deadlineAtMs: deadline, thresholdReached: true, superseded: false, supplierConfirmed: false, cancelled: false, paymentCleared: false, creditApproved: false }).reason, 'NOT_YET')
  assert.equal(prepareScheduledReminder({ kind: 'SUPPLIER_CONFIRMATION', nowMs: deadline, deadlineAtMs: deadline, thresholdReached: true, superseded: false, supplierConfirmed: true, cancelled: false, paymentCleared: false, creditApproved: false }).reason, 'CONFIRMED')
  assert.equal(prepareScheduledReminder({ kind: 'AGENT_PAYMENT', nowMs: deadline, deadlineAtMs: deadline, thresholdReached: true, superseded: false, supplierConfirmed: true, cancelled: false, paymentCleared: false, creditApproved: false }).reason, 'DEADLINE_PASSED')
  assert.equal(prepareScheduledReminder({ kind: 'SUPPLIER_OPTION', nowMs: deadline - 10, deadlineAtMs: deadline, thresholdReached: true, superseded: false, supplierConfirmed: false, cancelled: false, paymentCleared: false, creditApproved: true }).reason, 'CREDIT_APPROVED')
  assert.deepEqual(classifyDeliveryFailure('TRANSIENT'), { retry: true, escalate: false })
  assert.deepEqual(classifyDeliveryFailure('PERMANENT'), { retry: false, escalate: true })
  assert.equal(formatTimeRemaining(30_000), '0 minutes')
  rejects(() => renderHotelSupplierLpo(lpo({ identity: { tenantId: 'ten1', bookingId: 'BK1', event: 'lpo-v1', recipientRef: 'ops@fbed.example' } })), 'INVALID_KEY:recipientRef')
})
