const LEAD_NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,79}$/u

/** Lead guest names accepted by the booking form. The server still validates the prebook body. */
export function leadGuestError(firstName: string, lastName: string): string | null {
  const first = firstName.trim()
  const last = lastName.trim()
  if (!first || !last) return 'Enter the lead guest first and last name.'
  if (first.length > 80 || last.length > 80) return 'Each name must be 80 characters or fewer.'
  if (!LEAD_NAME.test(first) || !LEAD_NAME.test(last)) return 'Use letters for the lead guest name.'
  return null
}
