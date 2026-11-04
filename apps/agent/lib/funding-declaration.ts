import { parseMajorAmount } from './search-filters'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const MAX_AGE_DAYS = 366

export type FundingDraft = {
  amount: string
  reference: string
  valueDate: string
  payerName: string
  currency?: string
}

export type KnownReceipt = { bankReference: string; amountMinor: string; currency: string }

/**
 * Client checks that match the server declaration rules. The server remains authoritative.
 * Launch currency is AED (ADR 0029). This does not add other currencies.
 */
export function fundingDraftError(draft: FundingDraft, receipts: readonly KnownReceipt[] = [], now = Date.now()): string | null {
  const currency = draft.currency ?? 'AED'
  if (currency !== 'AED') return 'Launch funding is AED only.'
  const parsed = parseMajorAmount(draft.amount, 'AED')
  if (parsed.state === 'empty') return 'Enter the amount received.'
  if (parsed.state !== 'minor' || !Number.isSafeInteger(parsed.minor) || parsed.minor < 1) return 'Enter a positive AED amount in major units.'
  const amountMinor = String(parsed.minor)
  if (!/^[1-9][0-9]{0,17}$/.test(amountMinor)) return 'Enter a positive AED amount in major units.'
  const reference = draft.reference.trim().replace(/\s+/g, ' ')
  if (!reference) return 'Enter the bank reference.'
  if (reference.length > 80) return 'The bank reference must be at most 80 characters.'
  if (/[\u0000-\u001f\u007f]/.test(reference)) return 'The bank reference contains characters that cannot be stored.'
  const payer = draft.payerName.trim().replace(/\s+/g, ' ')
  if (!payer) return 'Enter who paid.'
  if (payer.length > 140) return 'The payer name must be at most 140 characters.'
  if (/[\u0000-\u001f\u007f]/.test(payer)) return 'The payer name contains characters that cannot be stored.'
  if (!DAY.test(draft.valueDate)) return 'Enter the date the money reached the account.'
  const valueDate = new Date(`${draft.valueDate}T00:00:00.000Z`)
  if (Number.isNaN(valueDate.getTime()) || valueDate.toISOString().slice(0, 10) !== draft.valueDate) return 'That value date is not a real date.'
  if (valueDate.getTime() > now + 14 * 3_600_000) return 'The value date cannot be in the future.'
  if (valueDate.getTime() < now - MAX_AGE_DAYS * DAY_MS) return 'The value date is more than a year old.'
  const canonical = reference.toUpperCase()
  if (receipts.some((receipt) => receipt.currency === 'AED' && receipt.amountMinor === amountMinor && receipt.bankReference.trim().toUpperCase() === canonical)) {
    return 'This reference, amount and currency are already declared. Declaring it again does not credit the wallet.'
  }
  return null
}
