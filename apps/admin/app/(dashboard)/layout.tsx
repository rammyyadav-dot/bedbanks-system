import type { ReactNode } from 'react'
import { AdminShell } from '@/components/layout/AdminShell'
import { requireAdminSession } from '@/lib/auth/session'
import { readSelectedTenantId } from '@/lib/auth/active-tenant'
import { resolveActiveTenantId } from '@/lib/api/tenant-context'

/**
 * Dashboard layout — server-side session validation.
 *
 * requireAdminSession() calls GET /auth/me (opaque session, ADR 0001 / ADR 0108),
 * refuses missing, expired or Agent-only sessions, and keeps only ADMIN /
 * SUPER_ADMIN memberships. Every page under (dashboard)/ inherits this check.
 *
 * The active tenant is the stored selection only when it is still one of the session's memberships (the cookie is
 * untrusted input; the API re-validates it on every call). The identity is passed to AdminShell for the topbar user display and
 * the logout button. Pages that need the full identity should call
 * getSession() themselves (it's cheap — Next.js deduplicates the fetch
 * within a single render pass via the same cache).
 */
export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const identity = await requireAdminSession()
  const activeTenantId = resolveActiveTenantId(identity.memberships, await readSelectedTenantId())

  return <AdminShell identity={identity} activeTenantId={activeTenantId}>{children}</AdminShell>
}
