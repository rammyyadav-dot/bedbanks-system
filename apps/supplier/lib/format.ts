export function formatMoney(minorUnits: number, currency: string): string {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError('Money must use integer minor units')
  }

  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minorUnits / 100)
}

export function formatSupplierType(type: string): string {
  return type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter: string) => letter.toUpperCase())
}
