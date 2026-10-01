'use client'

import { useCallback, useEffect, useState } from 'react'
import { AgentEntrance } from '@/components/entrance/agent-entrance'
import { AgentWorkspace } from './agent-workspace'
import { getAgentContext, logout, type AgentIdentity } from '@/lib/api-client'
import { clearAgentSessionMark, clearRecentSearches, consumeExpiredSession } from '@/lib/recent-searches'

export function AgentAuthGate() {
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [restoreError, setRestoreError] = useState(false)

  const restoreSession = useCallback(async () => {
    setLoading(true)
    setRestoreError(false)
    try {
      const context = await getAgentContext()
      setIdentity({ user: context.user, memberships: context.memberships })
      setSessionExpired(false)
    } catch (error) {
      setIdentity(null)
      const expired = error instanceof Error && error.message === 'Session expired' && consumeExpiredSession(window.sessionStorage)
      setSessionExpired(expired)
      setRestoreError(!(error instanceof Error && error.message === 'Session expired'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void restoreSession() }, [restoreSession])

  if (loading) return <main className="trade-state" aria-live="polite"><p>Checking your secure session…</p></main>
  if (identity) return <AgentWorkspace identity={identity} />
  return <AgentEntrance sessionExpired={sessionExpired} restoreError={restoreError} onRetry={() => { void restoreSession() }} onSignedIn={setIdentity} />
}

export function AgentSignOut({ userId, onComplete }: { userId: string; onComplete: () => void }) {
  return <button className="agent-signout" onClick={async () => {
    await logout()
    clearRecentSearches(window.sessionStorage, userId)
    clearAgentSessionMark(window.sessionStorage)
    onComplete()
  }}>Sign out</button>
}
