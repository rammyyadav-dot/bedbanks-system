import 'server-only';
import { cookies } from 'next/headers';

export const ACTIVE_TENANT_COOKIE = process.env.ACTIVE_TENANT_COOKIE_NAME ?? 'fbeds_active_tenant';

/** The stored tenant selection. Untrusted until resolved against the session's memberships (resolveActiveTenantId). */
export async function readSelectedTenantId(): Promise<string | null> {
  return (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value ?? null;
}
