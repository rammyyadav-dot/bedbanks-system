'use client'

import Link from 'next/link'
import { FormEvent, useEffect, useState } from 'react'
import { Eye, EyeOff, Headset, Info, MessageSquare, Rss } from 'lucide-react'
import { TradeFooter } from '@/components/entrance/trade-frame'
import { login, type AgentIdentity } from '@/lib/api-client'
import { entranceCards, heroCopy } from '@/lib/marketplace-content'
import { markAgentSession } from '@/lib/recent-searches'
import { safeReturnPath } from '@/lib/return-path'
import { signInErrorMessage } from '@/lib/sign-in-error'

export function AgentEntrance({
  sessionExpired,
  restoreError,
  onRetry,
  onSignedIn,
}: {
  sessionExpired: boolean
  restoreError: boolean
  onRetry: () => void
  onSignedIn: (identity: AgentIdentity) => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [returnPath, setReturnPath] = useState('/')
  useEffect(() => {
    setReturnPath(safeReturnPath(new URLSearchParams(window.location.search).get('next')))
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const identity = await login(String(form.get('email')), String(form.get('password')))
      markAgentSession(window.sessionStorage)
      if (returnPath !== '/') {
        window.location.assign(returnPath)
        return
      }
      onSignedIn(identity)
    } catch (caught) {
      setError(signInErrorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  const cardIcons = [Info, Headset, MessageSquare, Rss]
  return (
    <div className="trade-entrance">
      <section className="trade-hero">
        <div className="trade-panel">
          <p className="trade-logo-plate">fBeds</p>
          <h1>{heroCopy.headline}</h1>
          <p className="trade-lead">{heroCopy.supporting}</p>
          {sessionExpired && <p className="trade-banner" role="status">Your secure session has expired. Sign in again to continue.</p>}
          {restoreError && <p className="trade-banner is-error" role="alert">The workspace could not be restored. <button type="button" onClick={onRetry}>Retry</button></p>}
          <form onSubmit={handleSubmit} className="trade-signin" noValidate>
            <label htmlFor="email">Work email<input id="email" name="email" type="email" autoComplete="username" inputMode="email" required aria-describedby={error ? 'login-error' : undefined} /></label>
            <label htmlFor="password">Password<span className="password-field"><input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required aria-describedby={error ? 'login-error' : undefined} /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
            {error && <p id="login-error" className="trade-error" role="alert">{error}</p>}
            <button className="trade-button" disabled={submitting} type="submit">{submitting ? 'Signing in…' : heroCopy.primaryCta}</button>
          </form>
          <p className="trade-kicker">{heroCopy.joinLabel}</p>
          <p className="trade-partner">{heroCopy.partnerInvitation}</p>
          <Link className="trade-button is-secondary" href={`/access?next=${encodeURIComponent(returnPath)}`}>{heroCopy.secondaryCta}</Link>
        </div>
        <figure className="trade-hero-media">
          <img src="/dubai-marina-entrance.jpg" alt="Dubai marina waterfront in late afternoon light, with towers reflected in calm water." width={1280} height={720} />
        </figure>
      </section>
      <section className="trade-card-grid" aria-label="Company information">
        {entranceCards.map((card, index) => {
          const Icon = cardIcons[index] ?? Info
          return (
            <Link key={card.href} className="trade-info-card" href={card.href}>
              <span className="trade-card-icon" aria-hidden="true"><Icon size={18} /></span>
              <h2>{card.title}</h2>
              <p>{card.text}</p>
            </Link>
          )
        })}
      </section>
      <TradeFooter quiet />
    </div>
  )
}
