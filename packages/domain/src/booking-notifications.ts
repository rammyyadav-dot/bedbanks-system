import { formatMinorUnits, money } from '@bedbanks/money'

/**
 * fBed booking workflow and email notification standard (ADR 0111).
 * Plain text only. Every value is taken from the caller’s validated record; unresolved placeholders,
 * credential-like text and cross-audience commercial fields are rejected. This module does not send mail.
 * Callers must not log the rendered subject or body: both contain guest names.
 */

export const BOOKING_NOTIFICATION_TEMPLATE_VERSION = '2026-11-03'

export const OPERATIONAL_SEQUENCE = [
  'BOOKING_RECEIVED',
  'LPO_DISPATCHED',
  'SUPPLIER_CONFIRMED',
  'AGENT_NOTIFIED',
  'PAYMENT_OR_CREDIT_CLEARED',
  'VOUCHER_ISSUED',
  'STAY_COMPLETED',
  'RECONCILED',
] as const

export const BOOKING_NOTIFICATION_TEMPLATES = [
  'HOTEL_SUPPLIER_LPO',
  'SUPPLIER_REMINDER',
  'SUPPLIER_CONFIRMATION_RECORDED',
  'AGENT_BOOKING_CONFIRMATION',
  'AGENT_DEADLINE_REMINDER',
  'DEADLINE_OUTCOME',
  'SERVICE_VOUCHER',
  'INTERNAL_AUDIT_DIGEST',
] as const

export type BookingNotificationTemplate = (typeof BOOKING_NOTIFICATION_TEMPLATES)[number]
export type NotificationAudience = 'HOTEL_SUPPLIER' | 'AGENT' | 'TRAVELER_VOUCHER' | 'INTERNAL'
export type MealPlan = 'RO' | 'BB' | 'HB' | 'FB' | 'AI'
export type LpoBookingStatus = 'Awaiting Supplier Confirmation' | 'Confirmed'
export type AgentPaymentLabel = 'PAID' | 'UNPAID' | 'PART PAID' | 'CREDIT APPROVED' | 'OVERDUE'
export type AgentVoucherLabel = 'Pending Payment' | 'Pending Credit Approval' | 'Issued'
export type CommissionTreatment = 'Deductible' | 'Paid Separately' | 'Not Applicable'
export type DeadlineFocus = 'PAYMENT DUE' | 'OPTION EXPIRING'
export type AgentRequiredAction = 'Complete Payment' | 'Obtain Approved Credit Allocation' | 'Contact fBed Operations'
export type DeadlineOutcome = 'BOOKING RELEASED' | 'CANCELLATION PENDING' | 'BOOKING CANCELLED'
export type InternalEventType = 'BOOKING_STATUS' | 'SUPPLIER_STATUS' | 'PAYMENT_STATUS' | 'VOUCHER_STATUS' | 'CREDIT' | 'CANCELLATION' | 'LPO_EVENT' | 'AMENDMENT'
export type NotificationSource = 'Agent Portal' | 'Supplier API' | 'Admin' | 'Scheduled Job'
export type DispatchProgress = 'Queued' | 'Accepted' | 'Delivered' | 'Failed'
export type ReconciliationLabel = 'Unmatched' | 'Partially Matched' | 'Matched' | 'Exception'
export type ScheduledReminderKind = 'SUPPLIER_CONFIRMATION' | 'AGENT_PAYMENT' | 'SUPPLIER_OPTION'

export class NotificationRejected extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'NotificationRejected'
    this.code = code
  }
}

export interface MinorAmount { amountMinor: number; currency: string }
export interface MoneyLine { description: string; amount: MinorAmount }
export interface OperationsContact { email: string; phone: string }
export interface NotificationIdentity { tenantId: string; bookingId: string; event: string; recipientRef: string }

export interface RenderedBookingNotification {
  template: BookingNotificationTemplate
  templateVersion: typeof BOOKING_NOTIFICATION_TEMPLATE_VERSION
  audience: NotificationAudience
  subject: string
  text: string
  notificationKey: string
}

const MEAL_PLANS: readonly MealPlan[] = ['RO', 'BB', 'HB', 'FB', 'AI']
const PAYMENT_LABELS: readonly AgentPaymentLabel[] = ['PAID', 'UNPAID', 'PART PAID', 'CREDIT APPROVED', 'OVERDUE']
const VOUCHER_LABELS: readonly AgentVoucherLabel[] = ['Pending Payment', 'Pending Credit Approval', 'Issued']
const COMMISSION_TREATMENTS: readonly CommissionTreatment[] = ['Deductible', 'Paid Separately', 'Not Applicable']
const DEADLINE_FOCUS: readonly DeadlineFocus[] = ['PAYMENT DUE', 'OPTION EXPIRING']
const REQUIRED_ACTIONS: readonly AgentRequiredAction[] = ['Complete Payment', 'Obtain Approved Credit Allocation', 'Contact fBed Operations']
const OUTCOMES: readonly DeadlineOutcome[] = ['BOOKING RELEASED', 'CANCELLATION PENDING', 'BOOKING CANCELLED']
const INTERNAL_EVENTS: readonly InternalEventType[] = ['BOOKING_STATUS', 'SUPPLIER_STATUS', 'PAYMENT_STATUS', 'VOUCHER_STATUS', 'CREDIT', 'CANCELLATION', 'LPO_EVENT', 'AMENDMENT']
const SOURCES: readonly NotificationSource[] = ['Agent Portal', 'Supplier API', 'Admin', 'Scheduled Job']
const DISPATCH_PROGRESS: readonly DispatchProgress[] = ['Queued', 'Accepted', 'Delivered', 'Failed']
const RECONCILIATION: readonly ReconciliationLabel[] = ['Unmatched', 'Partially Matched', 'Matched', 'Exception']
const SECRET_WORD = /\b(?:cvv|cvc|passcode|password|api[-_ ]?key|client[-_ ]?secret|card number)\b/i
const ZONED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:[A-Za-z][A-Za-z0-9_+/-]{0,63}|[+-]\d{2}:\d{2})$/
const ALLOWED_TAG = /^\[(?:LPO|ACTION REQUIRED|URGENT|CONFIRMATION OVERDUE|CONFIRMATION RECORDED|BOOKING CONFIRMED|PAYMENT: (?:PAID|UNPAID|PART PAID|CREDIT APPROVED|OVERDUE)|PAYMENT DUE|OPTION EXPIRING|BOOKING RELEASED|CANCELLATION PENDING|BOOKING CANCELLED|VOUCHER ISSUED|INTERNAL|BOOKING_STATUS|SUPPLIER_STATUS|PAYMENT_STATUS|VOUCHER_STATUS|CREDIT|CANCELLATION|LPO_EVENT|AMENDMENT)\]$/
const AUDIENCE_FORBIDDEN: Record<NotificationAudience, readonly string[]> = {
  HOTEL_SUPPLIER: ['Agent Commission', 'Total Payable to fBed', 'Expected Gross Margin', 'Approved Credit', 'Outstanding Balance'],
  AGENT: ['Net Rate', 'Total LPO Value', 'Expected Gross Margin', 'Contracted Procurement Value', 'Procurement Currency'],
  TRAVELER_VOUCHER: ['Agent Commission', 'Net Rate', 'Expected Gross Margin', 'Total LPO Value', 'Outstanding Balance', 'Approved Credit', 'Commission Treatment'],
  INTERNAL: [],
}

function reject(code: string): never {
  throw new NotificationRejected(code)
}

function oneOf<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) reject(`INVALID_TEXT:${field}`)
  return value
}

export function plainText(value: string, field: string, max: number): string {
  if (typeof value !== 'string') reject(`INVALID_TEXT:${field}`)
  const trimmed = value.trim()
  if (!trimmed) reject(`EMPTY_FIELD:${field}`)
  if (trimmed.length > max || /[\r\n\u0000]/.test(trimmed) || trimmed.includes('[') || trimmed.includes(']')) reject(`INVALID_TEXT:${field}`)
  if (SECRET_WORD.test(trimmed)) reject(`CREDENTIAL_LIKE_TEXT:${field}`)
  return trimmed
}

function token(value: string, field: string): string {
  const id = plainText(value, field, 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) reject(`INVALID_KEY:${field}`)
  return id
}

function isoDate(value: string, field: string): string {
  const date = plainText(value, field, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) reject(`INVALID_DATE:${field}`)
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) reject(`INVALID_DATE:${field}`)
  return date
}

function zoned(value: string, field: string): string {
  const instant = plainText(value, field, 80)
  if (!ZONED.test(instant)) reject(`INVALID_INSTANT:${field}`)
  isoDate(instant.slice(0, 10), field)
  const hour = Number(instant.slice(11, 13))
  const minute = Number(instant.slice(14, 16))
  if (hour > 23 || minute > 59) reject(`INVALID_INSTANT:${field}`)
  return instant
}

function count(value: number, field: string, min: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > 999) reject(`INVALID_TEXT:${field}`)
  return value
}

function documentVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) reject(`INVALID_VERSION:${field}`)
  return value
}

export function minorAmount(amount: MinorAmount, field: string, allowNegative = false): MinorAmount {
  if (amount === null || typeof amount !== 'object') reject(`INVALID_MONEY:${field}`)
  try {
    money(amount.amountMinor, amount.currency)
  } catch {
    reject(`INVALID_MONEY:${field}`)
  }
  if (!allowNegative && amount.amountMinor < 0) reject(`INVALID_MONEY:${field}`)
  return { amountMinor: amount.amountMinor, currency: amount.currency }
}

function showMoney(amount: MinorAmount): string {
  try {
    return formatMinorUnits(amount.amountMinor, amount.currency)
  } catch {
    reject(`INVALID_MONEY:${amount.currency}`)
  }
}

function clock(value: string, field: string): string {
  const time = plainText(value, field, 5)
  if (!/^\d{2}:\d{2}$/.test(time)) reject(`INVALID_INSTANT:${field}`)
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(3, 5))
  if (hour > 23 || minute > 59) reject(`INVALID_INSTANT:${field}`)
  return time
}

function phone(value: string, field: string): string {
  const number = plainText(value, field, 40)
  if (!/^\+?[0-9][0-9 ()-]{5,38}$/.test(number)) reject(`INVALID_CONTACT:${field}`)
  return number
}

function orderedDates(checkIn: string, checkOut: string): { checkIn: string; checkOut: string } {
  const start = isoDate(checkIn, 'checkIn')
  const end = isoDate(checkOut, 'checkOut')
  if (Date.parse(`${end}T00:00:00Z`) <= Date.parse(`${start}T00:00:00Z`)) reject('STATUS_CONFLICT:nights')
  return { checkIn: start, checkOut: end }
}

function sameMoney(left: MinorAmount, right: MinorAmount, field: string): void {
  if (left.currency !== right.currency || left.amountMinor !== right.amountMinor) reject(`MONEY_MISMATCH:${field}`)
}

function lineTotal(lines: MoneyLine[], currency: string, field: string): MinorAmount {
  let total = minorAmount({ amountMinor: 0, currency }, field)
  lines.forEach((line, index) => {
    plainText(line.description, `${field}.${index}.description`, 200)
    const amount = minorAmount(line.amount, `${field}.${index}`)
    if (amount.currency !== currency) reject(`CURRENCY_MISMATCH:${field}`)
    total = minorAmount({ amountMinor: total.amountMinor + amount.amountMinor, currency }, field)
  })
  return total
}

function formatLines(lines: MoneyLine[], currency: string, field: string, prefix: string): string {
  if (lines.length === 0) return 'None'
  return lines.map((line, index) => {
    const amount = minorAmount(line.amount, `${field}.${index}`)
    if (amount.currency !== currency) reject(`CURRENCY_MISMATCH:${field}`)
    return `${plainText(line.description, `${field}.${index}.description`, 200)}: ${prefix}${showMoney(amount)}`
  }).join('; ')
}

function contact(input: OperationsContact, field: string): OperationsContact {
  const email = plainText(input.email, `${field}.email`, 254)
  const phone = plainText(input.phone, `${field}.phone`, 40)
  if (!/^[^\s@]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(email)) reject(`INVALID_CONTACT:${field}`)
  if (!/^\+?[0-9][0-9 ()-]{5,38}$/.test(phone)) reject(`INVALID_CONTACT:${field}`)
  return { email, phone }
}

function names(values: string[], field: string): string[] {
  if (!Array.isArray(values)) reject(`INVALID_TEXT:${field}`)
  return values.map((value, index) => plainText(value, `${field}.${index}`, 120))
}

function childAgeText(children: number, ages: number[]): string {
  if (!Array.isArray(ages) || (children === 0 && ages.length !== 0) || (children > 0 && ages.length !== children)) reject('STATUS_CONFLICT:childAges')
  if (children === 0) return 'Not Applicable'
  return ages.map((age, index) => {
    if (!Number.isSafeInteger(age) || age < 0 || age > 17) reject(`INVALID_TEXT:childAges.${index}`)
    return String(age)
  }).join(', ')
}

function stayOf(checkIn: string, checkOut: string, nights: number): { checkIn: string; checkOut: string; nights: number } {
  const start = isoDate(checkIn, 'checkIn')
  const end = isoDate(checkOut, 'checkOut')
  const counted = count(nights, 'nights', 1)
  const diffMs = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  if (diffMs <= 0 || diffMs % 86400000 !== 0 || diffMs / 86400000 !== counted) reject('STATUS_CONFLICT:nights')
  return { checkIn: start, checkOut: end, nights: counted }
}

function meal(value: MealPlan): MealPlan {
  return oneOf(value, MEAL_PLANS, 'mealPlan')
}

function amendmentLines(documentVersionNumber: number, changeSummary: string | null, noun: string): string[] {
  const current = documentVersion(documentVersionNumber, 'version')
  if (current === 1) {
    if (changeSummary !== null) reject('INVALID_VERSION:changeSummary')
    return []
  }
  if (changeSummary === null) reject('INVALID_VERSION:changeSummary')
  return [
    `This ${noun} version ${current} replaces version ${current - 1}. Earlier versions are invalid.`,
    `Change summary: ${plainText(changeSummary, 'changeSummary', 500)}`,
    '',
  ]
}

function section(title: string, rows: Array<[string, string]>): string {
  return [title, ...rows.map(([label, value]) => `- ${label}: ${value}`)].join('\n')
}

function regards(team: string, operations: OperationsContact, reference?: string): string {
  return ['Regards,', 'fBed Global Bedbank', team, `${operations.email} | ${operations.phone}`, ...(reference ? [`Reference: ${reference}`] : [])].join('\n')
}

function seal(template: BookingNotificationTemplate, audience: NotificationAudience, identity: NotificationIdentity, subject: string, text: string): RenderedBookingNotification {
  const combined = `${subject}\n${text}`
  const tags = combined.match(/\[[^\]\n]{0,160}\]/g) ?? []
  if ((combined.match(/\[/g) ?? []).length !== tags.length || (combined.match(/\]/g) ?? []).length !== tags.length) reject('UNRESOLVED_PLACEHOLDER')
  for (const tag of tags) if (!ALLOWED_TAG.test(tag)) reject('UNRESOLVED_PLACEHOLDER')
  for (const phrase of AUDIENCE_FORBIDDEN[audience]) if (text.includes(phrase)) reject(`AUDIENCE_LEAK:${audience}`)
  if (audience === 'INTERNAL' && (!text.includes('Expected Gross Margin') || !text.includes('Internal use only.'))) reject('INVALID_TEXT:internal')
  return {
    template,
    templateVersion: BOOKING_NOTIFICATION_TEMPLATE_VERSION,
    audience,
    subject,
    text,
    notificationKey: bookingNotificationKey({ ...identity, template }),
  }
}

export function bookingNotificationKey(input: NotificationIdentity & { template: BookingNotificationTemplate }): string {
  oneOf(input.template, BOOKING_NOTIFICATION_TEMPLATES, 'template')
  const tenantId = token(input.tenantId, 'tenantId')
  const bookingId = token(input.bookingId, 'bookingId')
  const event = token(input.event, 'event')
  const recipientRef = token(input.recipientRef, 'recipientRef')
  return `bkn/1/${BOOKING_NOTIFICATION_TEMPLATE_VERSION}/${tenantId}/${bookingId}/${input.template}/${event}/${recipientRef}`
}

/** Supplier acknowledgment is receipt only. Confirmed requires explicit acceptance or the contracted guarantee. */
export function supplierConfirmationDecision(input: { acknowledged: boolean; explicitAcceptance: boolean; contractualGuarantee: boolean }): { markConfirmed: boolean; acknowledgmentIsReceiptOnly: boolean } {
  if (typeof input.acknowledged !== 'boolean' || typeof input.explicitAcceptance !== 'boolean' || typeof input.contractualGuarantee !== 'boolean') reject('STATUS_CONFLICT:supplier')
  const markConfirmed = input.explicitAcceptance || input.contractualGuarantee
  return { markConfirmed, acknowledgmentIsReceiptOnly: input.acknowledged && !markConfirmed }
}

export function mayMarkBookingConfirmed(input: { explicitAcceptance: boolean; contractualGuarantee: boolean }): boolean {
  return supplierConfirmationDecision({ acknowledged: false, explicitAcceptance: input.explicitAcceptance, contractualGuarantee: input.contractualGuarantee }).markConfirmed
}

/** A cancellation request stays pending until the supplier confirms it under the applicable terms. */
export function resolveCancellationRequest(input: { requested: boolean; supplierConfirmed: boolean }): 'NONE' | 'PENDING' | 'CONFIRMED' {
  if (typeof input.requested !== 'boolean' || typeof input.supplierConfirmed !== 'boolean') reject('STATUS_CONFLICT:cancellation')
  if (!input.requested && input.supplierConfirmed) reject('STATUS_CONFLICT:cancellation')
  if (!input.requested) return 'NONE'
  return input.supplierConfirmed ? 'CONFIRMED' : 'PENDING'
}

/**
 * Auto-release runs only when the booking terms allow it, the deadline has passed, and payment,
 * approved credit and any authorized extension have been rechecked and are absent.
 */
export function evaluateAutoRelease(input: { termsPermitAutoRelease: boolean; deadlinePassed: boolean; paymentCleared: boolean; creditApproved: boolean; extensionAuthorized: boolean }): { release: boolean; reason: 'RELEASE' | 'TERMS_DO_NOT_PERMIT' | 'DEADLINE_NOT_REACHED' | 'PAYMENT_CLEARED' | 'CREDIT_APPROVED' | 'EXTENSION_AUTHORIZED' } {
  const flags = [input.termsPermitAutoRelease, input.deadlinePassed, input.paymentCleared, input.creditApproved, input.extensionAuthorized]
  if (flags.some((flag) => typeof flag !== 'boolean')) reject('STATUS_CONFLICT:autoRelease')
  if (!input.deadlinePassed) return { release: false, reason: 'DEADLINE_NOT_REACHED' }
  if (!input.termsPermitAutoRelease) return { release: false, reason: 'TERMS_DO_NOT_PERMIT' }
  if (input.paymentCleared) return { release: false, reason: 'PAYMENT_CLEARED' }
  if (input.creditApproved) return { release: false, reason: 'CREDIT_APPROVED' }
  if (input.extensionAuthorized) return { release: false, reason: 'EXTENSION_AUTHORIZED' }
  return { release: true, reason: 'RELEASE' }
}

/** The acknowledgment timer starts when dispatch is accepted, not when the text is rendered. */
export function acknowledgmentDeadlineMs(dispatchedAtMs: number, slaMs: number): number {
  if (!Number.isSafeInteger(dispatchedAtMs) || !Number.isSafeInteger(slaMs) || slaMs <= 0) reject('INVALID_INSTANT:sla')
  const deadline = dispatchedAtMs + slaMs
  if (!Number.isSafeInteger(deadline)) reject('INVALID_INSTANT:sla')
  return deadline
}

export function prepareScheduledReminder(input: {
  kind: ScheduledReminderKind
  nowMs: number
  deadlineAtMs: number
  thresholdReached: boolean
  superseded: boolean
  supplierConfirmed: boolean
  cancelled: boolean
  paymentCleared: boolean
  creditApproved: boolean
}): { send: boolean; reason: 'DUE' | 'SUPERSEDED' | 'CONFIRMED' | 'CANCELLED' | 'PAYMENT_CLEARED' | 'CREDIT_APPROVED' | 'DEADLINE_PASSED' | 'NOT_YET' } {
  if (input.kind !== 'SUPPLIER_CONFIRMATION' && input.kind !== 'AGENT_PAYMENT' && input.kind !== 'SUPPLIER_OPTION') reject('INVALID_TEXT:kind')
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.deadlineAtMs)) reject('INVALID_INSTANT:deadline')
  const flags = [input.thresholdReached, input.superseded, input.supplierConfirmed, input.cancelled, input.paymentCleared, input.creditApproved]
  if (flags.some((flag) => typeof flag !== 'boolean')) reject('STATUS_CONFLICT:reminder')
  if (input.superseded) return { send: false, reason: 'SUPERSEDED' }
  if (input.cancelled) return { send: false, reason: 'CANCELLED' }
  if (input.kind === 'SUPPLIER_CONFIRMATION') {
    if (input.supplierConfirmed) return { send: false, reason: 'CONFIRMED' }
    if (input.nowMs < input.deadlineAtMs) return { send: false, reason: 'NOT_YET' }
    return { send: true, reason: 'DUE' }
  }
  if (input.paymentCleared) return { send: false, reason: 'PAYMENT_CLEARED' }
  if (input.creditApproved) return { send: false, reason: 'CREDIT_APPROVED' }
  if (input.nowMs >= input.deadlineAtMs) return { send: false, reason: 'DEADLINE_PASSED' }
  if (!input.thresholdReached) return { send: false, reason: 'NOT_YET' }
  return { send: true, reason: 'DUE' }
}

export interface NotificationSchedule {
  supplierAcknowledgmentSlaMs: number
  supplierEscalationThresholdMs: number
  agentPaymentWarningBeforeDeadlineMs: number[]
  supplierOptionWarningBeforeExpiryMs: number[]
  finalReminderBeforeDeadlineMs: number
  operationsEscalationOwner: string
}

function duration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 366 * 24 * 60 * 60 * 1000) reject(`INVALID_SCHEDULE:${field}`)
  return value
}

function warningIntervals(values: number[], field: string, finalReminder: number): number[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 12) reject(`INVALID_SCHEDULE:${field}`)
  const intervals = values.map((value, index) => duration(value, `${field}.${index}`))
  for (let index = 0; index < intervals.length; index += 1) {
    const current = intervals[index]
    if (current === undefined || current <= finalReminder) reject(`INVALID_SCHEDULE:${field}`)
    const previous = index === 0 ? undefined : intervals[index - 1]
    if (previous !== undefined && current >= previous) reject(`INVALID_SCHEDULE:${field}`)
  }
  return intervals
}

export function validateNotificationSchedule(input: NotificationSchedule): NotificationSchedule {
  const supplierAcknowledgmentSlaMs = duration(input.supplierAcknowledgmentSlaMs, 'supplierAcknowledgmentSla')
  const supplierEscalationThresholdMs = duration(input.supplierEscalationThresholdMs, 'supplierEscalationThreshold')
  if (supplierEscalationThresholdMs < supplierAcknowledgmentSlaMs) reject('INVALID_SCHEDULE:supplierEscalationThreshold')
  const finalReminderBeforeDeadlineMs = duration(input.finalReminderBeforeDeadlineMs, 'finalReminder')
  return {
    supplierAcknowledgmentSlaMs,
    supplierEscalationThresholdMs,
    agentPaymentWarningBeforeDeadlineMs: warningIntervals(input.agentPaymentWarningBeforeDeadlineMs, 'agentPaymentWarning', finalReminderBeforeDeadlineMs),
    supplierOptionWarningBeforeExpiryMs: warningIntervals(input.supplierOptionWarningBeforeExpiryMs, 'supplierOptionWarning', finalReminderBeforeDeadlineMs),
    finalReminderBeforeDeadlineMs,
    operationsEscalationOwner: plainText(input.operationsEscalationOwner, 'operationsEscalationOwner', 120),
  }
}

export function formatTimeRemaining(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) reject('INVALID_INSTANT:timeRemaining')
  const totalMinutes = Math.floor(milliseconds / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (minutes || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`)
  return parts.join(' ')
}

export function classifyDeliveryFailure(kind: 'TRANSIENT' | 'PERMANENT'): { retry: boolean; escalate: boolean } {
  if (kind === 'TRANSIENT') return { retry: true, escalate: false }
  if (kind === 'PERMANENT') return { retry: false, escalate: true }
  reject('STATUS_CONFLICT:delivery')
}

export function nextDocumentVersion(input: { previousVersion: number; amendmentApproved: boolean }): { invalidatePrevious: boolean; nextVersion: number } {
  const previousVersion = documentVersion(input.previousVersion, 'previousVersion')
  if (typeof input.amendmentApproved !== 'boolean') reject('STATUS_CONFLICT:amendment')
  if (!input.amendmentApproved) return { invalidatePrevious: false, nextVersion: previousVersion }
  if (previousVersion >= 999) reject('INVALID_VERSION:nextVersion')
  return { invalidatePrevious: true, nextVersion: previousVersion + 1 }
}

export function voucherIssuancePermitted(input: { supplierConfirmed: boolean; paymentCleared: boolean; creditApproved: boolean }): boolean {
  if (typeof input.supplierConfirmed !== 'boolean' || typeof input.paymentCleared !== 'boolean' || typeof input.creditApproved !== 'boolean') reject('STATUS_CONFLICT:voucher')
  return input.supplierConfirmed && (input.paymentCleared || input.creditApproved)
}

export interface HotelSupplierLpoInput {
  identity: NotificationIdentity
  supplierName: string
  hotelName: string
  hotelAddress: string
  lpoId: string
  version: number
  changeSummary: string | null
  bookingStatus: LpoBookingStatus
  explicitAcceptance: boolean
  contractualGuarantee: boolean
  contractReference: string
  issuedAt: string
  checkIn: string
  checkOut: string
  nights: number
  leadGuest: string
  additionalGuests: string[]
  adults: number
  children: number
  childAges: number[]
  roomCategory: string
  roomCount: number
  occupancy: string
  mealPlan: MealPlan
  specialRequests: string[]
  currency: string
  rateBasis: string
  nightlyRates: MoneyLine[]
  roomSubtotal: MinorAmount
  taxes: MoneyLine[]
  extras: MoneyLine[]
  total: MinorAmount
  payableLocally: MoneyLine[]
  settlementTerms: string
  cancellationTerms: string
  cancellationDeadline: string
  noShowTerms: string
  optionExpiry: string | null
  acknowledgmentDeadline: string
  operations: OperationsContact
}

export function renderHotelSupplierLpo(input: HotelSupplierLpoInput): RenderedBookingNotification {
  const bookingStatus = oneOf(input.bookingStatus, ['Awaiting Supplier Confirmation', 'Confirmed'], 'bookingStatus')
  const confirmed = mayMarkBookingConfirmed({ explicitAcceptance: input.explicitAcceptance, contractualGuarantee: input.contractualGuarantee })
  if (confirmed !== (bookingStatus === 'Confirmed')) reject('STATUS_CONFLICT:bookingStatus')
  const stay = stayOf(input.checkIn, input.checkOut, input.nights)
  const currency = minorAmount({ amountMinor: 0, currency: input.currency }, 'currency').currency
  const roomSubtotal = minorAmount(input.roomSubtotal, 'roomSubtotal')
  const total = minorAmount(input.total, 'total')
  if (roomSubtotal.currency !== currency || total.currency !== currency) reject('CURRENCY_MISMATCH:total')
  if (input.nightlyRates.length === 0) reject('EMPTY_FIELD:nightlyRates')
  sameMoney(lineTotal(input.nightlyRates, currency, 'nightlyRates'), roomSubtotal, 'nightlyRates')
  const taxes = lineTotal(input.taxes, currency, 'taxes')
  const extras = lineTotal(input.extras, currency, 'extras')
  sameMoney(minorAmount({ amountMinor: roomSubtotal.amountMinor + taxes.amountMinor + extras.amountMinor, currency }, 'total'), total, 'total')
  const operations = contact(input.operations, 'operations')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const version = documentVersion(input.version, 'version')
  const subject = `[LPO][ACTION REQUIRED] ${token(input.lpoId, 'lpoId')} | ${plainText(input.hotelName, 'hotelName', 160)} | ${stay.checkIn} | ${bookingId}`
  const text = [
    `Dear ${plainText(input.supplierName, 'supplierName', 160)} Reservations Team,`,
    '',
    'Please process the following Local Purchase Order under our agreed contract and return your confirmation.',
    '',
    ...amendmentLines(version, input.changeSummary, 'LPO'),
    section('ORDER REFERENCES', [
      ['fBed Booking ID', bookingId],
      ['LPO ID / Version', `${token(input.lpoId, 'lpoId')} / ${version}`],
      ['Booking Status', bookingStatus],
      ['Contract Reference', plainText(input.contractReference, 'contractReference', 120)],
      ['Issued At', zoned(input.issuedAt, 'issuedAt')],
    ]),
    '',
    section('PROPERTY AND STAY', [
      ['Hotel', plainText(input.hotelName, 'hotelName', 160)],
      ['Property Address', plainText(input.hotelAddress, 'hotelAddress', 300)],
      ['Check-in', stay.checkIn],
      ['Check-out', stay.checkOut],
      ['Nights', String(stay.nights)],
    ]),
    '',
    section('GUESTS AND ACCOMMODATION', [
      ['Lead Guest', plainText(input.leadGuest, 'leadGuest', 120)],
      ['Additional Guests', names(input.additionalGuests, 'additionalGuests').join('; ') || 'None'],
      ['Adults / Children', `${count(input.adults, 'adults', 1)} / ${count(input.children, 'children', 0)}`],
      ['Child Ages at Check-in', childAgeText(count(input.children, 'children', 0), input.childAges)],
      ['Room Category', plainText(input.roomCategory, 'roomCategory', 160)],
      ['Room Count', String(count(input.roomCount, 'roomCount', 1))],
      ['Occupancy / Bedding', plainText(input.occupancy, 'occupancy', 160)],
      ['Meal Plan', meal(input.mealPlan)],
      ['Special Requests', names(input.specialRequests, 'specialRequests').join('; ') || 'None'],
      ['Special Request Status', 'Subject to written confirmation.'],
    ]),
    '',
    section('CONTRACTED PROCUREMENT VALUE', [
      ['Currency', currency],
      ['Rate Basis', plainText(input.rateBasis, 'rateBasis', 80)],
      ['Nightly Rate Breakdown', formatLines(input.nightlyRates, currency, 'nightlyRates', 'Net Rate ')],
      ['Room Subtotal', showMoney(roomSubtotal)],
      ['Taxes / Mandatory Charges', formatLines(input.taxes, currency, 'taxes', '')],
      ['Contracted Extras', formatLines(input.extras, currency, 'extras', '')],
      ['Total LPO Value', showMoney(total)],
      ['Payable Locally by Guest', formatLines(input.payableLocally, currency, 'payableLocally', '')],
      ['Settlement Terms', plainText(input.settlementTerms, 'settlementTerms', 400)],
    ]),
    '',
    section('BOOKING CONDITIONS', [
      ['Cancellation Terms', plainText(input.cancellationTerms, 'cancellationTerms', 800)],
      ['Cancellation Deadline', zoned(input.cancellationDeadline, 'cancellationDeadline')],
      ['No-show / Early Departure Terms', plainText(input.noShowTerms, 'noShowTerms', 800)],
      ['Supplier Option Expiry, if applicable', input.optionExpiry === null ? 'Not Applicable' : zoned(input.optionExpiry, 'optionExpiry')],
    ]),
    '',
    'ACTION REQUIRED',
    `Please confirm by ${zoned(input.acknowledgmentDeadline, 'acknowledgmentDeadline')}:`,
    '- Acceptance of the above rooms, dates, meal plan and contracted rates.',
    '- Hotel / Supplier Confirmation Number.',
    '- Any discrepancy or restriction requiring resolution.',
    '',
    'This LPO does not replace the underlying supplier agreement. Any variation requires written approval from fBed.',
    '',
    regards('Reservations & Operations', operations, bookingId),
  ].join('\n')
  return seal('HOTEL_SUPPLIER_LPO', 'HOTEL_SUPPLIER', input.identity, subject, text)
}

export interface SupplierReminderInput {
  identity: NotificationIdentity
  supplierName: string
  hotelName: string
  lpoId: string
  version: number
  leadGuest: string
  checkIn: string
  checkOut: string
  roomCount: number
  roomCategory: string
  dispatchedAt: string
  responseDeadline: string
  reminderNumber: number
  escalationDeadline: string
  currentBookingStatus: string
  supplierConfirmed: boolean
  cancelled: boolean
  superseded: boolean
  operations: OperationsContact
}

export function renderSupplierReminder(input: SupplierReminderInput): RenderedBookingNotification {
  if (input.supplierConfirmed || input.cancelled || input.superseded) reject('REMINDER_NOT_DUE')
  const operations = contact(input.operations, 'operations')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const hotelName = plainText(input.hotelName, 'hotelName', 160)
  const stay = orderedDates(input.checkIn, input.checkOut)
  const subject = `[URGENT][CONFIRMATION OVERDUE] ${bookingId} | ${hotelName} | Arrival ${stay.checkIn}`
  const text = [
    `Dear ${plainText(input.supplierName, 'supplierName', 160)} Operations Team,`,
    '',
    'Supplier confirmation remains outstanding for the following booking.',
    '',
    `- fBed Booking ID: ${bookingId}`,
    `- LPO ID / Version: ${token(input.lpoId, 'lpoId')} / ${documentVersion(input.version, 'version')}`,
    `- Hotel: ${hotelName}`,
    `- Lead Guest: ${plainText(input.leadGuest, 'leadGuest', 120)}`,
    `- Stay: ${stay.checkIn} to ${stay.checkOut}`,
    `- Accommodation: ${count(input.roomCount, 'roomCount', 1)} x ${plainText(input.roomCategory, 'roomCategory', 160)}`,
    `- LPO Dispatched At: ${zoned(input.dispatchedAt, 'dispatchedAt')}`,
    `- Original Response Deadline: ${zoned(input.responseDeadline, 'responseDeadline')}`,
    `- Reminder Number: ${count(input.reminderNumber, 'reminderNumber', 1)}`,
    '',
    `Please provide written acceptance and your confirmation number by ${zoned(input.escalationDeadline, 'escalationDeadline')}.`,
    '',
    'If accommodation cannot be confirmed as ordered, advise immediately with the reason and any available alternatives. Substitutions require fBed approval.',
    '',
    `The booking remains ${plainText(input.currentBookingStatus, 'currentBookingStatus', 80)} pending valid confirmation.`,
    '',
    regards('Supplier Operations', operations),
  ].join('\n')
  return seal('SUPPLIER_REMINDER', 'HOTEL_SUPPLIER', input.identity, subject, text)
}

export interface SupplierConfirmationRecordedInput {
  identity: NotificationIdentity
  supplierName: string
  hotelName: string
  lpoId: string
  version: number
  leadGuest: string
  checkIn: string
  checkOut: string
  roomDetails: string
  mealPlan: MealPlan
  supplierConfirmationNumber: string
  hotelConfirmationNumber: string | null
  procurementTotal: MinorAmount
  confirmedAt: string
  explicitAcceptance: boolean
  contractualGuarantee: boolean
  operations: OperationsContact
}

export function renderSupplierConfirmationRecorded(input: SupplierConfirmationRecordedInput): RenderedBookingNotification {
  if (!mayMarkBookingConfirmed({ explicitAcceptance: input.explicitAcceptance, contractualGuarantee: input.contractualGuarantee })) reject('STATUS_CONFLICT:bookingStatus')
  const operations = contact(input.operations, 'operations')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const supplierConfirmationNumber = plainText(input.supplierConfirmationNumber, 'supplierConfirmationNumber', 80)
  const total = minorAmount(input.procurementTotal, 'procurementTotal')
  const subject = `[CONFIRMATION RECORDED] ${bookingId} | Supplier Ref ${supplierConfirmationNumber}`
  const text = [
    `Dear ${plainText(input.supplierName, 'supplierName', 160)} Team,`,
    '',
    'We have recorded your confirmation for the following booking:',
    '',
    `- fBed Booking ID: ${bookingId}`,
    `- LPO ID / Version: ${token(input.lpoId, 'lpoId')} / ${documentVersion(input.version, 'version')}`,
    `- Hotel: ${plainText(input.hotelName, 'hotelName', 160)}`,
    `- Lead Guest: ${plainText(input.leadGuest, 'leadGuest', 120)}`,
    `- Stay: ${orderedDates(input.checkIn, input.checkOut).checkIn} to ${orderedDates(input.checkIn, input.checkOut).checkOut}`,
    `- Rooms / Meal Plan: ${plainText(input.roomDetails, 'roomDetails', 200)} / ${meal(input.mealPlan)}`,
    `- Supplier Confirmation Number: ${supplierConfirmationNumber}`,
    `- Hotel Confirmation Number: ${input.hotelConfirmationNumber === null ? 'Awaited' : plainText(input.hotelConfirmationNumber, 'hotelConfirmationNumber', 80)}`,
    `- Confirmed Procurement Total: ${showMoney(total)}`,
    `- Confirmed At: ${zoned(input.confirmedAt, 'confirmedAt')}`,
    '',
    'Please quote the fBed Booking ID in all further correspondence.',
    '',
    regards('Reservations & Operations', operations),
  ].join('\n')
  return seal('SUPPLIER_CONFIRMATION_RECORDED', 'HOTEL_SUPPLIER', input.identity, subject, text)
}

export interface AgentCommercialInput {
  currency: string
  accommodation: MinorAmount
  taxes: MinorAmount
  commission: MinorAmount
  commissionTreatment: CommissionTreatment
  cleared: MinorAmount
}

function agentCommercial(input: AgentCommercialInput): { currency: string; beforeCommission: MinorAmount; payable: MinorAmount; outstanding: MinorAmount; commission: MinorAmount; treatment: CommissionTreatment } {
  const currency = minorAmount({ amountMinor: 0, currency: input.currency }, 'currency').currency
  const accommodation = minorAmount(input.accommodation, 'accommodation')
  const taxes = minorAmount(input.taxes, 'taxes')
  const commission = minorAmount(input.commission, 'commission')
  const cleared = minorAmount(input.cleared, 'cleared')
  for (const amount of [accommodation, taxes, commission, cleared]) if (amount.currency !== currency) reject('CURRENCY_MISMATCH:commercial')
  const treatment = oneOf(input.commissionTreatment, COMMISSION_TREATMENTS, 'commissionTreatment')
  if (treatment === 'Not Applicable' && commission.amountMinor !== 0) reject('MONEY_MISMATCH:commission')
  const before = minorAmount({ amountMinor: accommodation.amountMinor + taxes.amountMinor, currency }, 'totalBeforeCommission')
  if (treatment === 'Deductible' && commission.amountMinor > before.amountMinor) reject('MONEY_MISMATCH:commission')
  const payableMinor = treatment === 'Deductible' ? before.amountMinor - commission.amountMinor : before.amountMinor
  const payable = minorAmount({ amountMinor: payableMinor, currency }, 'payable')
  if (cleared.amountMinor > payable.amountMinor) reject('MONEY_MISMATCH:cleared')
  return { currency, beforeCommission: before, payable, outstanding: minorAmount({ amountMinor: payable.amountMinor - cleared.amountMinor, currency }, 'outstanding'), commission, treatment }
}

export interface AgentBookingConfirmationInput {
  identity: NotificationIdentity
  supplierConfirmed: boolean
  agentContactName: string
  agencyName: string
  confirmationReference: string
  leadGuest: string
  additionalGuests: string[]
  hotelName: string
  checkIn: string
  checkOut: string
  nights: number
  rooms: string
  occupancy: string
  mealPlan: MealPlan
  specialRequests: string
  commercial: AgentCommercialInput
  paymentLabel: AgentPaymentLabel
  paymentDue: string
  optionExpiry: string | null
  cancellationDeadline: string
  cancellationTerms: string
  autoReleaseRule: string | null
  voucherReference: string | null
  voucherStatus: AgentVoucherLabel
  paymentCleared: boolean
  creditApproved: boolean
  deadlineWarning: string
  support: OperationsContact
}

export function renderAgentBookingConfirmation(input: AgentBookingConfirmationInput): RenderedBookingNotification {
  if (input.supplierConfirmed !== true) reject('STATUS_CONFLICT:supplierConfirmed')
  const commercial = agentCommercial(input.commercial)
  const voucherStatus = oneOf(input.voucherStatus, VOUCHER_LABELS, 'voucherStatus')
  const issued = voucherIssuancePermitted({ supplierConfirmed: true, paymentCleared: input.paymentCleared, creditApproved: input.creditApproved })
  if ((voucherStatus === 'Issued') !== issued) reject('STATUS_CONFLICT:voucherStatus')
  if (voucherStatus === 'Issued' && input.voucherReference === null) reject('EMPTY_FIELD:voucherReference')
  if (voucherStatus !== 'Issued' && input.voucherReference !== null) reject('STATUS_CONFLICT:voucherReference')
  const stay = stayOf(input.checkIn, input.checkOut, input.nights)
  const support = contact(input.support, 'support')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const hotelName = plainText(input.hotelName, 'hotelName', 160)
  const paymentLabel = oneOf(input.paymentLabel, PAYMENT_LABELS, 'paymentLabel')
  const subject = `[BOOKING CONFIRMED][PAYMENT: ${paymentLabel}] ${bookingId} | ${hotelName}`
  const text = [
    `Dear ${plainText(input.agentContactName, 'agentContactName', 120)},`,
    '',
    'Your accommodation booking has been confirmed with the supplier.',
    '',
    section('BOOKING DETAILS', [
      ['Agency', plainText(input.agencyName, 'agencyName', 160)],
      ['fBed Booking ID', bookingId],
      ['Supplier / Hotel Confirmation Reference', plainText(input.confirmationReference, 'confirmationReference', 120)],
      ['Lead Guest', plainText(input.leadGuest, 'leadGuest', 120)],
      ['Additional Guests', names(input.additionalGuests, 'additionalGuests').join('; ') || 'None'],
      ['Hotel', hotelName],
      ['Check-in / Check-out', `${stay.checkIn} / ${stay.checkOut}`],
      ['Nights', String(stay.nights)],
      ['Rooms / Occupancy', `${plainText(input.rooms, 'rooms', 160)} / ${plainText(input.occupancy, 'occupancy', 160)}`],
      ['Meal Plan', meal(input.mealPlan)],
      ['Special Requests', plainText(input.specialRequests, 'specialRequests', 400)],
    ]),
    '',
    section('AGENT COMMERCIAL SUMMARY', [
      ['Currency', commercial.currency],
      ['Accommodation Amount', showMoney(minorAmount(input.commercial.accommodation, 'accommodation'))],
      ['Taxes / Fees', showMoney(minorAmount(input.commercial.taxes, 'taxes'))],
      ['Total Before Commission', showMoney(commercial.beforeCommission)],
      ['Agent Commission', commercial.treatment === 'Not Applicable' ? 'Not Applicable' : showMoney(commercial.commission)],
      ['Commission Treatment', commercial.treatment],
      ['Total Payable to fBed', showMoney(commercial.payable)],
      ['Cleared Payments / Applied Credit', showMoney(minorAmount(input.commercial.cleared, 'cleared'))],
      ['Outstanding Balance', showMoney(commercial.outstanding)],
    ]),
    '',
    section('DEADLINES AND CONDITIONS', [
      ['Payment Due', zoned(input.paymentDue, 'paymentDue')],
      ['Supplier Option Expiry', input.optionExpiry === null ? 'Not Applicable' : zoned(input.optionExpiry, 'optionExpiry')],
      ['Cancellation Deadline', zoned(input.cancellationDeadline, 'cancellationDeadline')],
      ['Cancellation / No-show Terms', plainText(input.cancellationTerms, 'cancellationTerms', 800)],
      ['Auto-release Rule', input.autoReleaseRule === null ? 'Not Applicable' : plainText(input.autoReleaseRule, 'autoReleaseRule', 400)],
    ]),
    '',
    section('VOUCHER', [
      ['Voucher Reference', input.voucherReference === null ? 'Pending Issuance' : token(input.voucherReference, 'voucherReference')],
      ['Voucher Status', voucherStatus],
    ]),
    'Voucher issuance requires cleared payment or approved credit allocation.',
    '',
    'Please verify all booking details and report discrepancies immediately.',
    '',
    plainText(input.deadlineWarning, 'deadlineWarning', 400),
    '',
    regards('Agent Support', support),
  ].join('\n')
  return seal('AGENT_BOOKING_CONFIRMATION', 'AGENT', input.identity, subject, text)
}

export interface AgentDeadlineReminderInput {
  identity: NotificationIdentity
  focus: DeadlineFocus
  agentContactName: string
  hotelName: string
  leadGuest: string
  checkIn: string
  checkOut: string
  outstanding: MinorAmount
  paymentDeadline: string
  optionExpiry: string | null
  releaseDeadline: string | null
  timeRemaining: string
  requiredAction: AgentRequiredAction
  paymentInstructions: string
  approvedChannel: string
  autoReleaseWarning: string
  cancellationCharges: string
  paymentCleared: boolean
  creditApproved: boolean
  cancelled: boolean
  superseded: boolean
  deadlinePassed: boolean
  support: OperationsContact
}

export function renderAgentDeadlineReminder(input: AgentDeadlineReminderInput): RenderedBookingNotification {
  if (input.paymentCleared || input.creditApproved || input.cancelled || input.superseded || input.deadlinePassed) reject('REMINDER_NOT_DUE')
  const outstanding = minorAmount(input.outstanding, 'outstanding')
  const support = contact(input.support, 'support')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const focus = oneOf(input.focus, DEADLINE_FOCUS, 'focus')
  const deadline = focus === 'PAYMENT DUE' ? zoned(input.paymentDeadline, 'paymentDeadline') : (input.optionExpiry === null ? reject('EMPTY_FIELD:optionExpiry') : zoned(input.optionExpiry, 'optionExpiry'))
  const subject = `[ACTION REQUIRED][${focus}] ${bookingId} | Deadline ${deadline}`
  const text = [
    `Dear ${plainText(input.agentContactName, 'agentContactName', 120)},`,
    '',
    'Action is required to retain the following booking under its applicable terms.',
    '',
    `- fBed Booking ID: ${bookingId}`,
    `- Hotel: ${plainText(input.hotelName, 'hotelName', 160)}`,
    `- Lead Guest: ${plainText(input.leadGuest, 'leadGuest', 120)}`,
    `- Stay: ${orderedDates(input.checkIn, input.checkOut).checkIn} to ${orderedDates(input.checkIn, input.checkOut).checkOut}`,
    `- Outstanding Balance: ${showMoney(outstanding)}`,
    `- Payment Deadline: ${zoned(input.paymentDeadline, 'paymentDeadline')}`,
    `- Supplier Option Expiry: ${input.optionExpiry === null ? 'Not Applicable' : zoned(input.optionExpiry, 'optionExpiry')}`,
    `- Applicable Release Deadline: ${input.releaseDeadline === null ? 'Not Applicable' : zoned(input.releaseDeadline, 'releaseDeadline')}`,
    `- Time Remaining: ${plainText(input.timeRemaining, 'timeRemaining', 80)}`,
    '',
    'Required action:',
    oneOf(input.requiredAction, REQUIRED_ACTIONS, 'requiredAction'),
    '',
    `Payment Instructions: ${plainText(input.paymentInstructions, 'paymentInstructions', 400)}`,
    '',
    `If payment has already been initiated, submit the payment reference through ${plainText(input.approvedChannel, 'approvedChannel', 160)}. A remittance receipt alone does not establish cleared payment.`,
    '',
    plainText(input.autoReleaseWarning, 'autoReleaseWarning', 400),
    plainText(input.cancellationCharges, 'cancellationCharges', 400),
    '',
    'Any deadline extension must be explicitly approved and recorded by fBed.',
    '',
    regards('Accounts & Agent Support', support),
  ].join('\n')
  return seal('AGENT_DEADLINE_REMINDER', 'AGENT', input.identity, subject, text)
}

export interface DeadlineOutcomeInput {
  identity: NotificationIdentity
  outcome: DeadlineOutcome
  agentContactName: string
  hotelName: string
  leadGuest: string
  deadline: string
  deadlinePassed: boolean
  currentStatus: string
  actionCompleted: string
  supplierCancellationReference: string
  charges: { kind: 'AMOUNT'; amount: MinorAmount } | { kind: 'UNDER_REVIEW' }
  refundStatus: string
  explanation: string
  supportContact: string
  support: OperationsContact
  release: { termsPermitAutoRelease: boolean; paymentCleared: boolean; creditApproved: boolean; extensionAuthorized: boolean } | null
  cancellationRequested: boolean
  supplierConfirmedCancellation: boolean
}

export function renderDeadlineOutcome(input: DeadlineOutcomeInput): RenderedBookingNotification {
  if (input.deadlinePassed !== true) reject('STATUS_CONFLICT:deadline')
  const outcome = oneOf(input.outcome, OUTCOMES, 'outcome')
  if (outcome === 'BOOKING RELEASED') {
    if (input.release === null) reject('STATUS_CONFLICT:release')
    const decision = evaluateAutoRelease({ ...input.release, deadlinePassed: true })
    if (!decision.release) reject(`STATUS_CONFLICT:${decision.reason}`)
  } else if (input.release !== null) reject('STATUS_CONFLICT:release')
  const cancellation = resolveCancellationRequest({ requested: input.cancellationRequested, supplierConfirmed: input.supplierConfirmedCancellation })
  if (outcome === 'CANCELLATION PENDING' && cancellation !== 'PENDING') reject('STATUS_CONFLICT:cancellation')
  if (outcome === 'BOOKING CANCELLED' && cancellation !== 'CONFIRMED') reject('STATUS_CONFLICT:cancellation')
  if (outcome === 'BOOKING RELEASED' && cancellation === 'CONFIRMED') reject('STATUS_CONFLICT:cancellation')
  const support = contact(input.support, 'support')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const charges = input.charges.kind === 'UNDER_REVIEW' ? 'Under Review' : showMoney(minorAmount(input.charges.amount, 'charges'))
  const subject = `[${outcome}] ${bookingId}`
  const text = [
    `Dear ${plainText(input.agentContactName, 'agentContactName', 120)},`,
    '',
    'The applicable deadline for the following booking has expired.',
    '',
    `- fBed Booking ID: ${bookingId}`,
    `- Hotel: ${plainText(input.hotelName, 'hotelName', 160)}`,
    `- Lead Guest: ${plainText(input.leadGuest, 'leadGuest', 120)}`,
    `- Deadline: ${zoned(input.deadline, 'deadline')}`,
    `- Current Status: ${plainText(input.currentStatus, 'currentStatus', 80)}`,
    `- Action Completed: ${plainText(input.actionCompleted, 'actionCompleted', 200)}`,
    `- Supplier Cancellation Reference: ${plainText(input.supplierCancellationReference, 'supplierCancellationReference', 80)}`,
    `- Applicable Charges: ${charges}`,
    `- Refund Status: ${plainText(input.refundStatus, 'refundStatus', 120)}`,
    '',
    plainText(input.explanation, 'explanation', 800),
    '',
    `Please contact ${plainText(input.supportContact, 'supportContact', 120)} for assistance. Reinstatement is subject to availability, current rates and written confirmation.`,
    '',
    regards('Reservations & Accounts', support),
  ].join('\n')
  return seal('DEADLINE_OUTCOME', 'AGENT', input.identity, subject, text)
}

export interface ServiceVoucherInput {
  identity: NotificationIdentity
  supplierConfirmed: boolean
  paymentCleared: boolean
  creditApproved: boolean
  agentContactName: string
  voucherReference: string
  version: number
  changeSummary: string | null
  hotelConfirmationNumber: string
  issuedAt: string
  leadGuest: string
  additionalGuests: string[]
  adults: number
  children: number
  childAges: number[]
  hotelName: string
  hotelAddress: string
  hotelPhone: string
  checkIn: string
  checkOut: string
  nights: number
  roomCategory: string
  roomCount: number
  occupancy: string
  mealPlan: MealPlan
  inclusions: string[]
  payableAtProperty: MoneyLine[]
  payableCurrency: string
  checkInTime: string
  checkOutTime: string
  hotelTimeZone: string
  identification: string
  depositPolicy: string
  lateArrival: string
  earlyLate: string
  specialRequests: string
  support: OperationsContact
  emergencyPhone: string
  supportHours: string
}

export function renderServiceVoucher(input: ServiceVoucherInput): RenderedBookingNotification {
  if (!voucherIssuancePermitted({ supplierConfirmed: input.supplierConfirmed, paymentCleared: input.paymentCleared, creditApproved: input.creditApproved })) reject('STATUS_CONFLICT:voucher')
  const stay = stayOf(input.checkIn, input.checkOut, input.nights)
  const support = contact(input.support, 'support')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const voucherReference = token(input.voucherReference, 'voucherReference')
  const version = documentVersion(input.version, 'version')
  const hotelName = plainText(input.hotelName, 'hotelName', 160)
  const inclusions = names(input.inclusions, 'inclusions')
  if (inclusions.length === 0) reject('EMPTY_FIELD:inclusions')
  const travelerChildAges = childAgeText(count(input.children, 'children', 0), input.childAges)
  if (travelerChildAges.length === 0) reject('STATUS_CONFLICT:childAges')
  const currency = minorAmount({ amountMinor: 0, currency: input.payableCurrency }, 'payableCurrency').currency
  lineTotal(input.payableAtProperty, currency, 'payableAtProperty')
  const subject = `[VOUCHER ISSUED] ${voucherReference} | ${bookingId} | ${hotelName}`
  const text = [
    `Dear ${plainText(input.agentContactName, 'agentContactName', 120)},`,
    '',
    'Your official fBed accommodation voucher is ready.',
    '',
    'Please provide this voucher to the traveler and verify the stay details before arrival.',
    '',
    ...amendmentLines(version, input.changeSummary, 'voucher'),
    'fBed GLOBAL BEDBANK',
    'OFFICIAL ACCOMMODATION SERVICE VOUCHER',
    '',
    section('VOUCHER REFERENCES', [
      ['Voucher Reference / Version', `${voucherReference} / ${version}`],
      ['fBed Booking ID', bookingId],
      ['Hotel Confirmation Number', plainText(input.hotelConfirmationNumber, 'hotelConfirmationNumber', 80)],
      ['Issued At', zoned(input.issuedAt, 'issuedAt')],
    ]),
    '',
    section('TRAVELER AND STAY', [
      ['Lead Guest', plainText(input.leadGuest, 'leadGuest', 120)],
      ['Additional Guests', names(input.additionalGuests, 'additionalGuests').join('; ') || 'None'],
      ['Adults / Children', `${count(input.adults, 'adults', 1)} / ${count(input.children, 'children', 0)}`],
      ['Hotel', hotelName],
      ['Hotel Address', plainText(input.hotelAddress, 'hotelAddress', 300)],
      ['Hotel Reservations / Front Desk', phone(input.hotelPhone, 'hotelPhone')],
      ['Check-in Date', stay.checkIn],
      ['Check-out Date', stay.checkOut],
      ['Nights', String(stay.nights)],
      ['Room Category / Count', `${plainText(input.roomCategory, 'roomCategory', 160)} / ${count(input.roomCount, 'roomCount', 1)}`],
      ['Occupancy / Bedding', plainText(input.occupancy, 'occupancy', 160)],
      ['Meal Plan', meal(input.mealPlan)],
    ]),
    '',
    'INCLUDED SERVICES',
    ...inclusions.map((inclusion) => `- ${inclusion}`),
    '',
    'PAYABLE DIRECTLY AT PROPERTY',
    `- ${formatLines(input.payableAtProperty, currency, 'payableAtProperty', '')}`,
    '- Personal expenses and services outside the confirmed inclusions.',
    '',
    section('CHECK-IN POLICIES', [
      ['Standard Check-in Time', `${clock(input.checkInTime, 'checkInTime')}, ${plainText(input.hotelTimeZone, 'hotelTimeZone', 64)}`],
      ['Standard Check-out Time', `${clock(input.checkOutTime, 'checkOutTime')}, ${plainText(input.hotelTimeZone, 'hotelTimeZone', 64)}`],
      ['Identification Requirements', plainText(input.identification, 'identification', 300)],
      ['Deposit / Incidental Guarantee', plainText(input.depositPolicy, 'depositPolicy', 300)],
      ['Late Arrival Instructions', plainText(input.lateArrival, 'lateArrival', 300)],
      ['Early Check-in / Late Check-out', plainText(input.earlyLate, 'earlyLate', 300)],
      ['Special Requests', plainText(input.specialRequests, 'specialRequests', 400)],
    ]),
    '',
    'SUPPORT',
    `- fBed Agent Support: ${support.phone} | ${support.email}`,
    `- fBed Emergency Support: ${phone(input.emergencyPhone, 'emergencyPhone')}`,
    `- Support Hours / Time Zone: ${plainText(input.supportHours, 'supportHours', 120)}`,
    '',
    'Present this voucher and the required identification at check-in.',
    'For booking changes or cancellation, contact your booking agency or fBed through the approved support channel.',
    '',
    'Regards,',
    'fBed Global Bedbank',
    'Reservations & Guest Support',
  ].join('\n')
  return seal('SERVICE_VOUCHER', 'TRAVELER_VOUCHER', input.identity, subject, text)
}

export interface InternalAuditDigestInput {
  identity: NotificationIdentity
  eventId: string
  eventType: InternalEventType
  eventAt: string
  agencyId: string
  source: NotificationSource
  actorId: string
  correlationId: string
  reason: string
  bookingStatus: { previous: string; current: string }
  supplierStatus: { previous: string; current: string }
  paymentStatus: { previous: string; current: string }
  voucherStatus: { previous: string; current: string }
  hotelName: string
  supplierName: string
  checkIn: string
  checkOut: string
  roomCount: number
  nightCount: number
  lpoId: string
  lpoVersion: number
  supplierConfirmationNumber: string
  voucherReference: string
  voucherVersion: number
  procurementTotal: MinorAmount
  agentBillingTotal: MinorAmount
  commission: MinorAmount
  commissionTreatment: CommissionTreatment
  cleared: MinorAmount
  approvedCredit: MinorAmount
  outstanding: MinorAmount
  supplierPaid: MinorAmount
  supplierPayable: MinorAmount
  refundLiability: MinorAmount
  reporting: { currency: string; revenue: MinorAmount; procurement: MinorAmount; commission: MinorAmount; directCosts: MinorAmount; fxRate: string; fxSource: string; fxAsOf: string }
  notificationType: BookingNotificationTemplate
  recipientGroup: string
  dispatchStatus: DispatchProgress
  providerMessageId: string
  dispatchedAt: string
  retryCount: number
  ledgerReference: string
  supplierInvoiceReference: string
  reconciliationStatus: ReconciliationLabel
  exception: string | null
  owner: string
  nextAction: string | null
  nextDeadline: string | null
  auditRecord: string
}

export function renderInternalAuditDigest(input: InternalAuditDigestInput): RenderedBookingNotification {
  const procurement = minorAmount(input.procurementTotal, 'procurementTotal')
  const billing = minorAmount(input.agentBillingTotal, 'agentBillingTotal')
  const commission = minorAmount(input.commission, 'commission')
  const cleared = minorAmount(input.cleared, 'cleared')
  const credit = minorAmount(input.approvedCredit, 'approvedCredit')
  const outstanding = minorAmount(input.outstanding, 'outstanding')
  const supplierPaid = minorAmount(input.supplierPaid, 'supplierPaid')
  const supplierPayable = minorAmount(input.supplierPayable, 'supplierPayable')
  const refund = minorAmount(input.refundLiability, 'refundLiability')
  for (const amount of [commission, cleared, credit, outstanding]) if (amount.currency !== billing.currency) reject('CURRENCY_MISMATCH:agent')
  for (const amount of [supplierPaid, supplierPayable]) if (amount.currency !== procurement.currency) reject('CURRENCY_MISMATCH:supplier')
  const covered = minorAmount({ amountMinor: cleared.amountMinor + credit.amountMinor, currency: billing.currency }, 'covered')
  if (covered.amountMinor > billing.amountMinor) reject('MONEY_MISMATCH:covered')
  sameMoney(minorAmount({ amountMinor: billing.amountMinor - covered.amountMinor, currency: billing.currency }, 'outstanding'), outstanding, 'outstanding')
  const reportingCurrency = minorAmount({ amountMinor: 0, currency: input.reporting.currency }, 'reporting.currency').currency
  const revenue = minorAmount(input.reporting.revenue, 'reporting.revenue', true)
  const reportingProcurement = minorAmount(input.reporting.procurement, 'reporting.procurement')
  const reportingCommission = minorAmount(input.reporting.commission, 'reporting.commission')
  const directCosts = minorAmount(input.reporting.directCosts, 'reporting.directCosts')
  for (const amount of [revenue, reportingProcurement, reportingCommission, directCosts]) if (amount.currency !== reportingCurrency) reject('CURRENCY_MISMATCH:margin')
  if (procurement.currency === reportingCurrency) sameMoney(procurement, reportingProcurement, 'reporting.procurement')
  if (billing.currency === reportingCurrency) sameMoney(billing, revenue, 'reporting.revenue')
  if (commission.currency === reportingCurrency) sameMoney(commission, reportingCommission, 'reporting.commission')
  const margin = minorAmount({ amountMinor: revenue.amountMinor - reportingProcurement.amountMinor - reportingCommission.amountMinor - directCosts.amountMinor, currency: reportingCurrency }, 'margin', true)
  const treatment = oneOf(input.commissionTreatment, COMMISSION_TREATMENTS, 'commissionTreatment')
  if (treatment === 'Not Applicable' && commission.amountMinor !== 0) reject('MONEY_MISMATCH:commission')
  const eventType = oneOf(input.eventType, INTERNAL_EVENTS, 'eventType')
  const bookingId = token(input.identity.bookingId, 'bookingId')
  const stay = stayOf(input.checkIn, input.checkOut, input.nightCount)
  const previous = plainText(input.bookingStatus.previous, 'bookingStatus.previous', 80)
  const current = plainText(input.bookingStatus.current, 'bookingStatus.current', 80)
  const subject = `[INTERNAL][${eventType}] ${bookingId} | ${previous} -> ${current}`
  const text = [
    'fBed INTERNAL TRANSACTION DIGEST',
    '',
    section('EVENT', [
      ['Event ID', token(input.eventId, 'eventId')],
      ['Event Type', eventType],
      ['Event Timestamp', zoned(input.eventAt, 'eventAt')],
      ['Booking ID', bookingId],
      ['Tenant / Agency ID', `${token(input.identity.tenantId, 'tenantId')} / ${token(input.agencyId, 'agencyId')}`],
      ['Source', oneOf(input.source, SOURCES, 'source')],
      ['Actor', token(input.actorId, 'actorId')],
      ['Correlation ID', token(input.correlationId, 'correlationId')],
      ['Reason / Approval Reference', plainText(input.reason, 'reason', 300)],
    ]),
    '',
    section('STATE CHANGE', [
      ['Booking Status', `${previous} -> ${current}`],
      ['Supplier Status', `${plainText(input.supplierStatus.previous, 'supplierStatus.previous', 80)} -> ${plainText(input.supplierStatus.current, 'supplierStatus.current', 80)}`],
      ['Payment Status', `${plainText(input.paymentStatus.previous, 'paymentStatus.previous', 80)} -> ${plainText(input.paymentStatus.current, 'paymentStatus.current', 80)}`],
      ['Voucher Status', `${plainText(input.voucherStatus.previous, 'voucherStatus.previous', 80)} -> ${plainText(input.voucherStatus.current, 'voucherStatus.current', 80)}`],
    ]),
    '',
    section('BOOKING REFERENCES', [
      ['Hotel / Supplier', `${plainText(input.hotelName, 'hotelName', 160)} / ${plainText(input.supplierName, 'supplierName', 160)}`],
      ['Stay', `${stay.checkIn} to ${stay.checkOut}`],
      ['Rooms / Nights', `${count(input.roomCount, 'roomCount', 1)} / ${stay.nights}`],
      ['LPO ID / Version', `${token(input.lpoId, 'lpoId')} / ${documentVersion(input.lpoVersion, 'lpoVersion')}`],
      ['Supplier Confirmation Number', plainText(input.supplierConfirmationNumber, 'supplierConfirmationNumber', 80)],
      ['Voucher Reference / Version', `${token(input.voucherReference, 'voucherReference')} / ${documentVersion(input.voucherVersion, 'voucherVersion')}`],
    ]),
    '',
    section('FINANCIAL POSITION', [
      ['Procurement Currency / Total', showMoney(procurement)],
      ['Agent Billing Currency / Total', showMoney(billing)],
      ['Commission / Treatment', `${showMoney(commission)} / ${treatment}`],
      ['Cleared Receipts', showMoney(cleared)],
      ['Approved Credit Allocated', showMoney(credit)],
      ['Agent Outstanding Balance', showMoney(outstanding)],
      ['Supplier Paid / Payable', `${showMoney(supplierPaid)} / ${showMoney(supplierPayable)}`],
      ['Refund / Cancellation Liability', showMoney(refund)],
      ['Reporting Currency / FX Reference', `${reportingCurrency} / ${plainText(input.reporting.fxRate, 'fxRate', 40)}, ${plainText(input.reporting.fxSource, 'fxSource', 80)}, ${zoned(input.reporting.fxAsOf, 'fxAsOf')}`],
      ['Expected Gross Margin', showMoney(margin)],
      ['Margin Basis', 'Revenue less Procurement, Commission and Applicable Direct Costs, without Double Counting'],
    ]),
    '',
    section('COMMUNICATION RECORD', [
      ['Notification Type', oneOf(input.notificationType, BOOKING_NOTIFICATION_TEMPLATES, 'notificationType')],
      ['Template Version', BOOKING_NOTIFICATION_TEMPLATE_VERSION],
      ['Recipient Group / Recipient Reference', `${plainText(input.recipientGroup, 'recipientGroup', 80)} / ${token(input.identity.recipientRef, 'recipientRef')}`],
      ['Dispatch Status', oneOf(input.dispatchStatus, DISPATCH_PROGRESS, 'dispatchStatus')],
      ['Provider Message ID', plainText(input.providerMessageId, 'providerMessageId', 120)],
      ['Dispatched At', zoned(input.dispatchedAt, 'dispatchedAt')],
      ['Retry Count', String(count(input.retryCount, 'retryCount', 0))],
    ]),
    '',
    section('RECONCILIATION AND FOLLOW-UP', [
      ['Payment / Ledger Reference', plainText(input.ledgerReference, 'ledgerReference', 120)],
      ['Supplier Invoice Reference', plainText(input.supplierInvoiceReference, 'supplierInvoiceReference', 120)],
      ['Reconciliation Status', oneOf(input.reconciliationStatus, RECONCILIATION, 'reconciliationStatus')],
      ['Exception / Variance', input.exception === null ? 'None' : plainText(input.exception, 'exception', 300)],
      ['Assigned Owner', plainText(input.owner, 'owner', 120)],
      ['Next Action', input.nextAction === null ? 'None' : plainText(input.nextAction, 'nextAction', 200)],
      ['Next Deadline', input.nextDeadline === null ? 'Not Applicable' : zoned(input.nextDeadline, 'nextDeadline')],
      ['Secure Audit Record', plainText(input.auditRecord, 'auditRecord', 200)],
    ]),
    '',
    'Internal use only. Access is restricted to authorized personnel.',
  ].join('\n')
  return seal('INTERNAL_AUDIT_DIGEST', 'INTERNAL', input.identity, subject, text)
}

export type BookingNotificationRequest =
  | { template: 'HOTEL_SUPPLIER_LPO'; input: HotelSupplierLpoInput }
  | { template: 'SUPPLIER_REMINDER'; input: SupplierReminderInput }
  | { template: 'SUPPLIER_CONFIRMATION_RECORDED'; input: SupplierConfirmationRecordedInput }
  | { template: 'AGENT_BOOKING_CONFIRMATION'; input: AgentBookingConfirmationInput }
  | { template: 'AGENT_DEADLINE_REMINDER'; input: AgentDeadlineReminderInput }
  | { template: 'DEADLINE_OUTCOME'; input: DeadlineOutcomeInput }
  | { template: 'SERVICE_VOUCHER'; input: ServiceVoucherInput }
  | { template: 'INTERNAL_AUDIT_DIGEST'; input: InternalAuditDigestInput }

export function renderBookingNotification(request: BookingNotificationRequest): RenderedBookingNotification {
  switch (request.template) {
    case 'HOTEL_SUPPLIER_LPO': return renderHotelSupplierLpo(request.input)
    case 'SUPPLIER_REMINDER': return renderSupplierReminder(request.input)
    case 'SUPPLIER_CONFIRMATION_RECORDED': return renderSupplierConfirmationRecorded(request.input)
    case 'AGENT_BOOKING_CONFIRMATION': return renderAgentBookingConfirmation(request.input)
    case 'AGENT_DEADLINE_REMINDER': return renderAgentDeadlineReminder(request.input)
    case 'DEADLINE_OUTCOME': return renderDeadlineOutcome(request.input)
    case 'SERVICE_VOUCHER': return renderServiceVoucher(request.input)
    case 'INTERNAL_AUDIT_DIGEST': return renderInternalAuditDigest(request.input)
    default: return reject('INVALID_TEXT:template')
  }
}
