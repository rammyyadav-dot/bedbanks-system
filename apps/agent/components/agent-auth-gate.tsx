'use client'

import { FormEvent, useEffect, useState } from 'react'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { AgentWorkspace } from './agent-workspace'
import { getAgentContext, login, logout, type AgentIdentity } from '@/lib/api-client'

export function AgentAuthGate() {
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    getAgentContext()
      .then((context) => setIdentity({ user: context.user, memberships: context.memberships }))
      .catch(() => setSessionExpired(true))
      .finally(() => setLoading(false))
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const nextIdentity = await login(String(form.get('email')), String(form.get('password')))
      setIdentity(nextIdentity)
    } catch {
      setError('We could not sign you in. Check your credentials and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <main className="auth-state" aria-live="polite"><p>Checking your secure session…</p></main>
  if (identity) return <AgentWorkspace identity={identity} />

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-brand-row"><div className="auth-mark" aria-hidden="true">f</div><span className="auth-secure"><ShieldCheck size={14} /> Secure access</span></div>
        <p className="auth-kicker">FBEDS / AGENT PORTAL</p>
        <h1 id="login-title">Sign in to your workspace</h1>
        <p className="auth-copy">Access tenant-scoped hotel inventory, rates and booking operations.</p>
        {sessionExpired && <p className="auth-info" role="status">Your secure session has expired. Sign in again to continue.</p>}
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <label htmlFor="email">Work email<input id="email" name="email" type="email" autoComplete="username" inputMode="email" required aria-describedby={error ? 'login-error' : undefined} /></label>
          <label htmlFor="password">Password<div className="password-field"><input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required aria-describedby={error ? 'login-error' : undefined} /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
          {error && <p id="login-error" className="auth-error" role="alert">{error}</p>}
          <button disabled={submitting} type="submit">{submitting ? 'Signing in…' : 'Sign in securely'}</button>
        </form>
        <p className="auth-note">Your session is protected by an HttpOnly cookie. Never share your credentials.</p>
      </section>
    </main>
  )
}

export function AgentSignOut({ onComplete }: { onComplete: () => void }) {
  return <button className="agent-signout" onClick={async () => { await logout(); onComplete() }}>Sign out</button>
}
