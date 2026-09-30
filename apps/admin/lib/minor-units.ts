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
