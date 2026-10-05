'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentEntrance } from '@/components/entrance/agent-entrance'
import { AgentWorkspace } from './agent-workspace'
import { agentSession, getAgentContext, logout, type AgentIdentity } from '@/lib/api-client'
import { clearGuestNationality } from '@/lib/guest-market'
import { clearAgentSessionMark, clearRecentSearches, consumeExpiredSession } from '@/lib/recent-searches'
import { SESSION_EXPIRED_EVENT } from '@/lib/session-events.mjs'

export function AgentAuthGate() {
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [restoreError, setRestoreError] = useState(false)
  const sessionEpoch = useRef(0)
  const identityRef = useRef<AgentIdentity | null>(null)
  identityRef.current = identity

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

  // A signed-in agent whose session disappears mid-journey (an API call answered 401) goes back to sign-in with a clear notice. Account-specific
  // browser state is cleared, and the in-flight epoch is invalidated so a late context response cannot revive the old identity.
  useEffect(() => {
    const onExpired = () => {
      const current = identityRef.current
      if (!current) return
      sessionEpoch.current += 1
      clearRecentSearches(window.sessionStorage, current.user.id)
      clearGuestNationality(window.sessionStorage, current.user.id)
      setIdentity(null)
      setRestoreError(false)
      setSessionExpired(true)
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [])

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
