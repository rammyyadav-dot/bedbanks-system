'use client'

import { RouteError } from '@/components/common/RouteError'

/** Catches render and server-data failures in any dashboard page; the shell (navigation, tenant switcher) stays usable. */
export default function DashboardError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="admin-page"><RouteError {...props} homeHref="/dashboard" /></div>
}
