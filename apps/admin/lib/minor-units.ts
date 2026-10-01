export function isMinorUnits(value: string): boolean {
  return /^\d+$/.test(value)
}

export function currencyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Formats integer minor units with BigInt so large values never pass through floating point. */
export function formatMinorUnits(amountMinor: string, currency: string): string {
  if (!/^-?\d+$/.test(amountMinor) || !/^[A-Z]{3}$/.test(currency)) return '—'
  const digits = currencyFractionDigits(currency)
  const minor = BigInt(amountMinor)
  const negative = minor < 0n
  const absolute = negative ? -minor : minor
  const factor = 10n ** BigInt(digits)
  const whole = (absolute / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = digits === 0 ? '' : `.${(absolute % factor).toString().padStart(digits, '0')}`
  return `${negative ? '-' : ''}${currency} ${whole}${fraction}`
}

/**
 * Parses a major-unit decimal string ("450", "450.5", "450.50") into integer minor units for the currency,
 * using BigInt only. Returns null when the text is not a plain non-negative decimal or has more fraction
 * digits than the currency allows (so nothing is silently rounded).
 */
export function parseMajorToMinor(amountMajor: string, currency: string): string | null {
  const digits = currencyFractionDigits(currency)
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amountMajor.trim())
  if (!match) return null
  const fraction = match[2] ?? ''
  if (fraction.length > digits || (digits === 0 && match[2] !== undefined)) return null
  const minor = BigInt(match[1]) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0')
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? minor.toString() : null
}

/** Integer minor units back to an editable major-unit decimal string ("45000","AED" → "450.00"), BigInt only. */
export function minorToMajorInput(amountMinor: string, currency: string): string {
  if (!/^\d+$/.test(amountMinor) || !/^[A-Z]{3}$/.test(currency)) return ''
  const digits = currencyFractionDigits(currency)
  const minor = BigInt(amountMinor)
  const factor = 10n ** BigInt(digits)
  const whole = (minor / factor).toString()
  return digits === 0 ? whole : `${whole}.${(minor % factor).toString().padStart(digits, '0')}`
}
