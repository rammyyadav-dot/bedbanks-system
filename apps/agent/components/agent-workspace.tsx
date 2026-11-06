'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ShieldAlert } from 'lucide-react'
import { AgentSignOut } from './agent-auth-gate'
import { AgentPortal } from './agent-portal'
import { getAgentContext, getFinanceSummary, getSearchStatus, type AgentIdentity, type FinanceSummary } from '@/lib/api-client'
import { financeCreditLabel, nextFinanceView, type FinanceView } from '@/lib/finance-view'
import { formatMinorAmount } from '@/lib/format'
import { accessForTenant, CLOSED_ACCESS, type PortalAccess } from '@/lib/portal-access'
import { shouldApplyTenantResponse } from '@/lib/tenant-response'
import { CurrencyOptionsContext } from '@/components/search/currency-options'

type Grants = {
  tenantId: string
  access: PortalAccess
}

export function AgentWorkspace({ identity }: { identity: AgentIdentity }) {
  const [tenantId, setTenantId] = useState(identity.memberships.length === 1 ? identity.memberships[0].tenantId : '')
  const [grants, setGrants] = useState<Grants | null>(null)
  const [finance, setFinance] = useState<FinanceView<FinanceSummary>>({ phase: 'loading', summary: null })
  const [providerStatus, setProviderStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable'>('idle')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const tenantRef = useRef(tenantId)
  tenantRef.current = tenantId
  const access = grants && shouldApplyTenantResponse(grants.tenantId, tenantId) ? grants.access : CLOSED_ACCESS

  const refreshFinance = () => {
    if (!tenantId || !access.finance.enabled) return
    const requested = tenantId
    void getFinanceSummary(requested).then(
      (summary) => { if (shouldApplyTenantResponse(requested, tenantRef.current)) setFinance((current) => nextFinanceView(current, { ok: true, summary })) },
      (reason: unknown) => {
        if (!shouldApplyTenantResponse(requested, tenantRef.current)) return
        setFinance((current) => nextFinanceView(current, { ok: false, denied: reason instanceof Error && reason.message === 'Access denied' }))
      },
    )
  }

  useEffect(() => {
    if (!tenantId) {
      setGrants(null)
      setFinance({ phase: 'loading', summary: null })
      setProviderStatus('idle')
      return
    }
    const requested = tenantId
    setGrants(null)
    setFinance({ phase: 'loading', summary: null })
    setProviderStatus('checking')
    setError('')
    let active = true
    void getAgentContext(requested).then((context) => {
      if (!active || !shouldApplyTenantResponse(requested, tenantRef.current)) return
      if (!shouldApplyTenantResponse(requested, context.capabilityTenantId)) {
        setError('Workspace access could not be confirmed. Search and booking stay closed until it loads.')
        return
      }
      setGrants({
        tenantId: context.capabilityTenantId,
        access: accessForTenant(requested, tenantRef.current, context),
      })
    }).catch((reason: unknown) => {
      if (!active) return
      setError(reason instanceof Error && reason.message === 'Access denied'
        ? 'You no longer have access to this workspace. Select another workspace or sign in again.'
        : 'Workspace access could not be confirmed. Search and booking stay closed until it loads.')
    })
    return () => { active = false }
  }, [tenantId, attempt])

  useEffect(() => {
    if (!tenantId || !access.finance.enabled) {
      if (grants && !access.finance.shown) setFinance({ phase: 'denied', summary: null })
      return
    }
    const requested = tenantId
    let active = true
    setProviderStatus('checking')
    Promise.allSettled([getFinanceSummary(requested), access.search.enabled ? getSearchStatus(requested) : Promise.resolve({ status: 'not_checked' as const })])
      .then(([financeResult, statusResult]) => {
        if (!active || !shouldApplyTenantResponse(requested, tenantRef.current)) return
        setFinance(nextFinanceView({ phase: 'loading', summary: null }, financeResult.status === 'fulfilled'
          ? { ok: true, summary: financeResult.value }
          : { ok: false, denied: financeResult.reason instanceof Error && financeResult.reason.message === 'Access denied' }))
        if (statusResult.status === 'fulfilled') setProviderStatus(statusResult.value.status === 'not_checked' ? 'idle' : 'unavailable')
        else {
          setProviderStatus('unavailable')
          setError(statusResult.reason instanceof Error && statusResult.reason.message === 'Session expired'
            ? 'Your secure session expired. Sign in again to continue.'
            : statusResult.reason instanceof Error && statusResult.reason.message === 'Access denied'
              ? 'You no longer have access to this workspace. Select another workspace or sign in again.'
              : 'The supplier API is unavailable. Search and booking verification are disabled until it recovers.')
        }
      })
    return () => { active = false }
  }, [tenantId, access.finance.enabled, access.finance.shown, access.search.enabled, grants])

  const active = Boolean(tenantId) && !error && grants !== null
  const Shell = active ? 'div' : 'main'
  const creditLabel = financeCreditLabel(finance.phase, formatMinorAmount(finance.summary?.availableCredit, finance.summary?.currency))
  return <Shell className={`workspace-page ${active ? 'is-active' : ''}`}>
    {!active && <header className="workspace-header"><div><p className="auth-kicker">FBEDS / AGENT PORTAL</p><h1>Workspace access</h1><p>Choose a verified workspace to continue.</p></div><AgentSignOut userId={identity.user.id} onComplete={() => window.location.reload()} /></header>}
    {(!active || identity.memberships.length > 1) && <section className="workspace-card" aria-labelledby="workspace-title">
      <div className="workspace-card-heading"><div><span className="workspace-eyebrow">ACTIVE TENANT CONTEXT</span><h2 id="workspace-title">Select your workspace</h2></div><ShieldAlert aria-hidden="true" /></div>
      {identity.memberships.length === 0 && <div className="workspace-message warning" role="alert"><AlertTriangle size={18} /><p>Your account has no active workspaces. Contact your platform administrator.</p></div>}
      {identity.memberships.length > 1 && <p className="workspace-helper">Workspace access is verified server-side for every request. Switching workspace refreshes the active authorization context.</p>}
      <label className="workspace-select-label" htmlFor="active-workspace">Active workspace<select id="active-workspace" value={tenantId} onChange={(event) => setTenantId(event.target.value)} disabled={!identity.memberships.length}><option value="">Choose a workspace</option>{identity.memberships.map((membership) => <option key={membership.tenantId} value={membership.tenantId}>{membership.tenantName} · {membership.role}</option>)}</select><ChevronDown size={16} aria-hidden="true" /></label>
      {error && <div className="workspace-message warning" role="alert"><AlertTriangle size={18} /><p>{error}</p><button type="button" className="portal-link" onClick={() => setAttempt((current) => current + 1)}>Retry</button></div>}
      {tenantId && !error && !grants && <p role="status">Checking your access for this workspace…</p>}
      {tenantId && !error && grants && <div className="workspace-status-grid"><div><span>Supplier status</span><strong className={`status-${providerStatus}`}>{providerStatus === 'checking' ? 'Checking access…' : providerStatus === 'idle' ? 'Not yet checked' : 'Unavailable'}</strong></div><div><span>Finance status</span><strong>{creditLabel}</strong>{finance.phase === 'stale' || finance.phase === 'unavailable' ? <button type="button" className="portal-link" onClick={refreshFinance}>Retry balance</button> : null}</div></div>}
    </section>}
    {active && <CurrencyOptionsContext.Provider value={identity.settlementCurrencies}><AgentPortal key={tenantId} finance={finance} identity={identity} tenantId={tenantId} providerStatus={providerStatus} access={access} onFinanceChanged={refreshFinance} /></CurrencyOptionsContext.Provider>}
  </Shell>
}
