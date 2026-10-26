'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { RefreshCw } from 'lucide-react'

/** Re-runs the current route's server data fetch without a full page reload. */
export function RetryButton({ label = 'Retry' }: { label?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  return <button type="button" disabled={pending} aria-busy={pending} onClick={() => startTransition(() => router.refresh())}><RefreshCw size={14} /> {pending ? 'Retrying…' : label}</button>
}
