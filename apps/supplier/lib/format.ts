import { formatMinorUnits } from '@bedbanks/money'

export function formatMoney(minorUnits: number, currency: string): string {
  if (!Number.isSafeInteger(minorUnits)) throw new TypeError('Money must use integer minor units')
  return formatMinorUnits(minorUnits, currency)
}

export function formatSupplierType(type: string): string {
  return type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}
