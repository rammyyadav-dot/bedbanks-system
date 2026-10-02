function occupancyCompact(rooms, adults, children) {
  return `${rooms}R · ${adults}A${children ? ` · ${children}C` : ''}`
}

const EXPONENTS = { AED: 2, AUD: 2, BHD: 3, CAD: 2, EUR: 2, GBP: 2, INR: 2, JPY: 0, KWD: 3, OMR: 3, QAR: 2, SAR: 2, SGD: 2, USD: 2 }

function wholeAmount(minor, currency) {
  const exponent = EXPONENTS[currency] ?? 2
  if (!Number.isSafeInteger(minor) || minor < 0) return ''
  const scale = 10n ** BigInt(exponent)
  const value = BigInt(minor)
  const fraction = value % scale
  const whole = value / scale
  if (fraction === 0n) return whole.toString()
  return `${whole}.${fraction.toString().padStart(exponent, '0').replace(/0+$/, '')}`
}

export function stayOccupancyLabel(rooms, adults, children, childAges = []) {
  const base = occupancyCompact(rooms, adults, children)
  if (!children || childAges.length !== children) return base
  return `${base} · ages ${childAges.join(', ')}`
}

/** Compact label for filters that replay will apply. Prices are total-stay amounts in minor units. */
export function activeFilterLabel(input) {
  const parts = []
  const stars = [...new Set(input.starRatings ?? [])].filter((star) => Number.isInteger(star) && star >= 1 && star <= 5).sort((left, right) => right - left)
  if (stars.length) parts.push(stars.map((star) => `${star}★`).join(' '))
  if (input.refundableOnly) parts.push('Refundable')
  const currency = input.currency ?? 'AED'
  const min = input.minPriceMinor === undefined ? '' : wholeAmount(input.minPriceMinor, currency)
  const max = input.maxPriceMinor === undefined ? '' : wholeAmount(input.maxPriceMinor, currency)
  if (min && max) parts.push(`${currency} ${min}–${max} total`)
  else if (min) parts.push(`${currency} ${min}+ total`)
  else if (max) parts.push(`Up to ${currency} ${max} total`)
  return parts.join(' · ')
}
