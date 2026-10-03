'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentEntrance } from '@/components/entrance/agent-entrance'
import { AgentWorkspace } from './agent-workspace'
import { agentSession, getAgentContext, logout, type AgentIdentity } from '@/lib/api-client'
import { clearGuestNationality } from '@/lib/guest-market'
import { clearAgentSessionMark, clearRecentSearches, consumeExpiredSession } from '@/lib/recent-searches'

export function AgentAuthGate() {
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [restoreError, setRestoreError] = useState(false)
  const sessionEpoch = useRef(0)

  const restoreSession = useCallback(async () => {
    const generation = ++sessionEpoch.current
    setLoading(true)
    setRestoreError(false)
    try {
      const context = await getAgentContext()
      if (sessionEpoch.current !== generation) return
      setIdentity(agentSession(context, context.bookingEnabled, context.settlementCurrencies))
      setSessionExpired(false)
    } catch (error) {
      if (sessionEpoch.current !== generation) return
      setIdentity(null)
      const expired = error instanceof Error && error.message === 'Session expired' && consumeExpiredSession(window.sessionStorage)
      setSessionExpired(expired)
      setRestoreError(!(error instanceof Error && error.message === 'Session expired'))
    } finally {
      if (sessionEpoch.current === generation) setLoading(false)
    }
  }, [])

  const acceptSignIn = useCallback(async (signedIn: AgentIdentity) => {
    const generation = ++sessionEpoch.current
    setIdentity(agentSession(signedIn, false, signedIn.settlementCurrencies))
    setSessionExpired(false)
    setRestoreError(false)
    try {
      const context = await getAgentContext()
      if (sessionEpoch.current !== generation) return
      setIdentity(agentSession(context, context.bookingEnabled, context.settlementCurrencies))
    } catch {
      if (sessionEpoch.current !== generation) return
      setIdentity(agentSession(signedIn, false, signedIn.settlementCurrencies))
    }
  }, [])

  useEffect(() => { void restoreSession() }, [restoreSession])

  if (loading) return <main className="trade-state" aria-live="polite"><p>Checking your secure session…</p></main>
  if (identity) return <AgentWorkspace identity={identity} />
  return <AgentEntrance sessionExpired={sessionExpired} restoreError={restoreError} onRetry={() => { void restoreSession() }} onSignedIn={(signedIn) => { void acceptSignIn(signedIn) }} />
}

export function AgentSignOut({ userId, onComplete }: { userId: string; onComplete: () => void }) {
  return <button className="agent-signout" onClick={async () => {
    await logout()
    clearRecentSearches(window.sessionStorage, userId)
    clearGuestNationality(window.sessionStorage, userId)
    clearAgentSessionMark(window.sessionStorage)
    onComplete()
  }}>Sign out</button>
}
