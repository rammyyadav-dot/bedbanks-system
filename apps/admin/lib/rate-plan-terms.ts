/** Rate plan sale window and payment type as the form edits them (ADR 0057). The API is the authority; this only shapes input and output. */
export type PaymentTypeValue = 'PREPAID' | 'PAY_AT_HOTEL'
export const PAYMENT_TYPE_OPTIONS: ReadonlyArray<{ value: PaymentTypeValue; label: string }> = [
  { value: 'PREPAID', label: 'Prepaid' },
  { value: 'PAY_AT_HOTEL', label: 'Pay at hotel' },
]

/** The API returns dates as ISO instants; the date input needs the calendar day. */
export const dayFromApi = (value: string | null | undefined): string => (value ? value.slice(0, 10) : '')

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Blank means "not set" (null). Anything else must be a calendar day; the server re-validates against the contract. */
export function termsFromForm(form: { validFrom: string; validTo: string; paymentType: string }): { ok: true; terms: { validFrom: string | null; validTo: string | null; paymentType: PaymentTypeValue | null } } | { ok: false; message: string } {
  const from = form.validFrom.trim(), to = form.validTo.trim()
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return { ok: false, message: 'Sale window dates must be real calendar days.' }
  if (from && to && to < from) return { ok: false, message: 'The sale window ends before it starts.' }
  const payment = form.paymentType
  if (payment !== '' && !PAYMENT_TYPE_OPTIONS.some((option) => option.value === payment)) return { ok: false, message: 'Choose a payment type from the list, or leave it unset.' }
  return { ok: true, terms: { validFrom: from || null, validTo: to || null, paymentType: (payment || null) as PaymentTypeValue | null } }
}
