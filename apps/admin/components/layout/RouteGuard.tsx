'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useCan, useCapabilityStatus } from '@/lib/auth/capabilities'
import { resolveRouteAccess } from '@/lib/auth/route-access'

/** Renders a page only once the caller's permissions for the active tenant are known and allow the route. */
export function RouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const can = useCan()
  const status = useCapabilityStatus()
  const access = resolveRouteAccess(pathname, status, can)
  if (access === 'allow') return <>{children}</>
  if (access === 'checking') return <p role="status" aria-live="polite" style={{ padding: 24 }}>Checking your access…</p>
  if (access === 'unavailable') return (
    <div role="alert" style={{ padding: 24 }}>
      <p>Your permissions could not be verified. Retry, or contact an administrator if this continues.</p>
      <button type="button" className="admin-btn" onClick={() => window.location.reload()}>Retry</button>
    </div>
  )
  return <p role="alert" style={{ padding: 24 }}>You do not have permission to view this page. Contact your tenant administrator if you need access.</p>
}
