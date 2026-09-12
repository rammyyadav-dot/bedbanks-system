/** Never includes passwordHash — this is the only shape that should ever leave the API. */
export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface MembershipSummary {
  tenantId: string;
  tenantName: string;
  role: string;
}

/**
 * The trusted identity attached to `req.user` by SessionAuthGuard.
 * Only ever constructed inside the guard, from a validated session —
 * never from anything the browser sent (body, query, headers other
 * than the session cookie itself).
 */
export interface AuthenticatedUser {
  user: SafeUser;
  memberships: MembershipSummary[];
}
