/**
 * Guest personal data is masked for readers without `booking.pii.view` (ADR 0039). Masking keeps the first letter of each name part so an
 * operator can still tell two rows apart, and never reveals length: every masked part ends in the same three bullets.
 */
export function maskNamePart(part: string): string {
  const first = [...part.trim()][0]
  return first ? `${first.toUpperCase()}•••` : ''
}

export function maskedGuestName(firstName: string, lastName: string): string {
  return [maskNamePart(firstName), maskNamePart(lastName)].filter(Boolean).join(' ')
}

export function guestName(firstName: string, lastName: string, reveal: boolean): { name: string; masked: boolean } {
  return reveal ? { name: `${firstName.trim()} ${lastName.trim()}`.trim(), masked: false } : { name: maskedGuestName(firstName, lastName), masked: true }
}
