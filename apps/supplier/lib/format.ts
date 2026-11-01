import { formatMinorUnits, minorUnitExponent } from '@bedbanks/money'

export function formatMoney(minorUnits: number, currency: string): string {
  if (!Number.isSafeInteger(minorUnits)) throw new TypeError('Money must use integer minor units')
  return formatMinorUnits(minorUnits, currency)
}

export function formatSupplierType(type: string): string {
  return type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}

export const NOT_RECORDED = 'Not recorded'

/**
 * Formats an integer string of minor units (the API sends amounts as strings). Pure bigint arithmetic, no floating point.
 * `null` is "Not recorded", never zero. An unsupported currency shows the raw minor units rather than guessing a scale.
 */
export function formatNetMinor(value: string | null, currency: string): string {
  if (value === null) return NOT_RECORDED
  if (!/^-?\d+$/.test(value)) return NOT_RECORDED
  let exponent: number
  try {
    exponent = minorUnitExponent(currency)
  } catch {
    return `${value} minor units (${currency})`
  }
  const amount = BigInt(value)
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const scale = 10n ** BigInt(exponent)
  const whole = (absolute / scale).toLocaleString('en-GB')
  const fraction = exponent === 0 ? '' : `.${(absolute % scale).toString().padStart(exponent, '0')}`
  return `${negative ? '-' : ''}${currency} ${whole}${fraction}`
}

export const NET_STATUS_LABEL: Record<string, string> = {
  RECORDED: 'Recorded',
  PARTIAL: 'Partly recorded',
  NOT_RECORDED: NOT_RECORDED,
  MISMATCH: 'Needs review',
}
