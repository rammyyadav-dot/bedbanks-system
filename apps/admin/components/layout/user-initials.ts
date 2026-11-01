import type { AuthenticatedUser } from '@/lib/api/auth-client';

export function userInitials(user: AuthenticatedUser['user']): string {
  if (user.name) {
    return user.name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
  return user.email.slice(0, 2).toUpperCase();
}
