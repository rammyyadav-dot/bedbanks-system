'use client'

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import Link from 'next/link'

/**
 * Shared body for Next.js error boundaries. The message of a thrown error is never rendered (it may carry server
 * detail); only Next's opaque digest is shown so support can find the matching server log line.
 */
export function RouteError({ error, reset, homeHref }: { error: Error & { digest?: string }; reset: () => void; homeHref?: string }) {
  useEffect(() => {
    console.error(JSON.stringify({ level: 'error', event: 'admin_route_error', digest: error.digest ?? null, name: error.name }))
  }, [error])
  return (
    <section className="admin-auth-state" role="alert">
      <span className="admin-auth-state-icon"><AlertTriangle size={22} /></span>
      <h2>Something went wrong</h2>
      <p>This view could not be displayed. Nothing was changed by loading it. Retry, or return to the dashboard if the problem continues.</p>
      {error.digest ? <p>Reference: <code>{error.digest}</code></p> : null}
      <button type="button" onClick={reset}><RefreshCw size={14} /> Retry</button>
      {homeHref ? <Link href={homeHref}>Back to dashboard</Link> : null}
    </section>
  )
}
