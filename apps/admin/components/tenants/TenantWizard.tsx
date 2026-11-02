'use client'

import Link from 'next/link'
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { routes, type TenantBusiness } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { PageHeader } from '@/components/common/PageHeader'
import { BusinessFields, emptyBusiness } from './BusinessFields'

const steps = ['Business identity', 'Legal & compliance', 'Primary administrator', 'Commercial setup', 'Review & create']

export function TenantWizard({
  variant = 'dialog', onClose, onCreated,
}: {
  variant?: 'dialog' | 'page'
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [step, setStep] = useState(0)
  const [business, setBusiness] = useState<TenantBusiness>(emptyBusiness)
  const [slug, setSlug] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const key = useRef<string | null>(null)

  function updateBusiness(next: TenantBusiness) {
    setBusiness(next)
    key.current = null
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (step < 4) { setStep(step + 1); return }
    setBusy(true)
    key.current ??= crypto.randomUUID()
    try {
      const result = await apiRequest<{ id: string }>(routes.platform.tenantCreate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key.current },
        body: JSON.stringify({ slug, business, administratorEmail: email }),
      })
      onCreated(result.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tenant creation failed')
    } finally {
      setBusy(false)
    }
  }

  function trapDialog(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !busy) onClose()
    if (event.key !== 'Tab') return
    const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]'))
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  const form = (
    <>
      <ol className="tenant-steps">{steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{index + 1}. {label}</li>)}</ol>
      <form onSubmit={submit}>
        <h3>{steps[step]}</h3>
        {step === 0 && (
          <>
            <BusinessFields value={business} onChange={updateBusiness} section="identity" />
            <label className="tenant-field">Tenant code / slug<input required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={80} value={slug} onChange={(event) => { setSlug(event.target.value); key.current = null }} /></label>
          </>
        )}
        {step === 1 && (
          <>
            <BusinessFields value={business} onChange={updateBusiness} section="legal" />
            <p className="tenant-note">Compliance starts pending. Verification documents must remain in approved private storage; document upload is unavailable until that workflow is configured.</p>
          </>
        )}
        {step === 2 && (
          <>
            <label className="tenant-field">Verified administrator email<input type="email" required value={email} onChange={(event) => { setEmail(event.target.value); key.current = null }} /></label>
            <p className="tenant-note">The first user is attached as tenant owner (agency administrator). Attach an existing active user with a verified sign-in. The operator cannot select themselves. Secure invitation email, Cognito/OIDC provisioning and MFA enrollment are not configured.</p>
          </>
        )}
        {step === 3 && (
          <>
            <BusinessFields value={business} onChange={updateBusiness} section="commercial" />
            <p className="tenant-note">Selling currency and markup policy references are business preferences. Credit limits and wallets are not configured here; after activation they remain in Agencies and Finance through their canonical maker-checker workflows.</p>
          </>
        )}
        {step === 4 && (
          <>
            <dl className="tenant-facts">
              {Object.entries({ ...business, slug, administratorEmail: email }).map(([name, value]) => (
                <div key={name}>
                  <dt>{name.replace(/([A-Z])/g, ' $1')}</dt>
                  <dd>{Array.isArray(value) ? value.join(', ') || 'Unconfigured' : typeof value === 'boolean' ? value ? 'Reviewed' : 'Pending' : String(value) || '—'}</dd>
                </div>
              ))}
            </dl>
            <p className="tenant-note">Tenant is created suspended and pending review. Activation requires readiness checks and a different authorized approver.</p>
          </>
        )}
        {error && <p className="tenant-error" role="alert">{error}</p>}
        <div className="tenant-actions">
          <button type="button" className="admin-btn" onClick={() => setStep(step - 1)} disabled={step === 0 || busy}>Back</button>
          <button type="submit" className="admin-btn tenant-primary" disabled={busy}>{busy ? 'Creating…' : step === 4 ? 'Create pending tenant' : 'Continue'}</button>
        </div>
      </form>
    </>
  )

  if (variant === 'page') {
    return (
      <div className="admin-page tenant-control">
        <PageHeader
          eyebrow="BUSINESS · TENANT ONBOARDING"
          title="Register tenant"
          description="Provision a B2B travel agency tenant. The record is created suspended pending independent review."
          actions={<Link href="/tenants" className="admin-btn">Back to directory</Link>}
        />
        <section className="tenant-panel tenant-wizard-page">{form}</section>
      </div>
    )
  }

  return (
    <div className="tenant-modal-backdrop">
      <section className="tenant-modal" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onKeyDown={trapDialog}>
        <div className="tenant-panel-head">
          <div><span className="tenant-eyebrow">TENANT ONBOARDING</span><h2 id="wizard-title">Create tenant</h2></div>
          <button type="button" className="admin-btn" onClick={onClose} disabled={busy} autoFocus>Close</button>
        </div>
        {form}
      </section>
    </div>
  )
}
