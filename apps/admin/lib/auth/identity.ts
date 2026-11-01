import type { SafeUser } from '@/lib/api/auth-client'

/** Initials from the authenticated display name, falling back to the email local part. Never reads session secrets. */
export function userInitials(user: Pick<SafeUser, 'name' | 'email'>): string {
  const words = (user.name ?? '').split(/\s+/).filter(Boolean)
  if (words.length > 0) return words.slice(0, 2).map((word) => Array.from(word)[0]).join('').toUpperCase()
  return Array.from(user.email.split('@')[0] || '?').slice(0, 2).join('').toUpperCase()
}
