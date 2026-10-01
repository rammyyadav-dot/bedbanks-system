function occupancyCompact(rooms, adults, children) {
  return `${rooms}R · ${adults}A${children ? ` · ${children}C` : ''}`
}

function wholeAmount(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) return ''
  const value = BigInt(minor)
  if (value % 100n !== 0n) return ''
  return (value / 100n).toString()
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
  const min = input.minPriceMinor === undefined ? '' : wholeAmount(input.minPriceMinor)
  const max = input.maxPriceMinor === undefined ? '' : wholeAmount(input.maxPriceMinor)
  if (min && max) parts.push(`${currency} ${min}–${max} total`)
  else if (min) parts.push(`${currency} ${min}+ total`)
  else if (max) parts.push(`Up to ${currency} ${max} total`)
  return parts.join(' · ')
}
