import type { ReactNode } from 'react'
import { AdminShell } from '@/components/layout/AdminShell'
import { requireSession } from '@/lib/auth/session'

/**
 * Dashboard layout — server-side session validation.
 *
 * requireSession() calls GET /auth/me, validates the opaque session
 * cookie against the database, and redirects to /login if the session
 * is missing or expired. Every page under (dashboard)/ inherits this
 * check automatically — individual pages don't need to repeat it.
 *
 * The identity is passed to AdminShell for the topbar user display and
 * the logout button. Pages that need the full identity should call
 * getSession() themselves (it's cheap — Next.js deduplicates the fetch
 * within a single render pass via the same cache).
 */
export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  const identity = await requireSession()

  return <AdminShell identity={identity}>{children}</AdminShell>
}
