export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

/**
 * ADR 0091 password rules for a NEW password (login still accepts any existing one). Deliberately small and explainable:
 * length is what matters, so there are no composition rules. No breached-password lookup is made; that needs an outbound service the platform does not have.
 * Returns the first problem as a message safe to show the user, or null when the password is acceptable.
 */
export function passwordPolicyProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`
  const normalized = password.trim().toLowerCase()
  const address = email.trim().toLowerCase()
  const local = address.split('@')[0] ?? ''
  if (normalized === address || (local.length >= 4 && normalized.includes(local))) return 'Do not use your email address in your password.'
  if (new Set(normalized).size < 5) return 'Use a password with more variety than a repeated pattern.'
  if (/^(?:password|passw0rd|qwerty|letmein|welcome|admin|fabbeds|fbeds)[\w!@#$%^&*]*$/.test(normalized) && normalized.length < 16) return 'That password is too easy to guess.'
  return null
}
