'use client'

import { RouteError } from '@/components/common/RouteError'

/** Catches failures the dashboard boundary cannot: the dashboard layout itself, for example when the session service is down. */
export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="admin-page"><RouteError {...props} /></main>
}
