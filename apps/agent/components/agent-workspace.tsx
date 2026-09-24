'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ShieldAlert } from 'lucide-react'
import { AgentSignOut } from './agent-auth-gate'
import { AgentPortal } from './agent-portal'
import { getFinanceSummary, getSearchStatus, type AgentIdentity } from '@/lib/api-client'

export function AgentWorkspace({ identity }: { identity: AgentIdentity }) {
  const [tenantId, setTenantId] = useState(identity.memberships.length === 1 ? identity.memberships[0].tenantId : '')
  const [finance, setFinance] = useState<{ status: string; availableCredit: number | null } | null>(null)
  const [providerStatus, setProviderStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!tenantId) { setFinance(null); setProviderStatus('idle'); return }
    setProviderStatus('checking')
    setError('')
    Promise.all([getFinanceSummary(tenantId), getSearchStatus(tenantId)])
      .then(([financeSummary, status]) => { setFinance(financeSummary); setProviderStatus(status.status === 'available' ? 'available' : 'unavailable') })
      .catch((requestError: Error) => { setFinance(null); setProviderStatus('unavailable'); setError(requestError.message === 'Access denied' ? 'You no longer have access to this workspace. Select another workspace or sign in again.' : 'We could not load this workspace. Please try again.') })
  }, [tenantId])

  return <main className="workspace-page">
    <header className="workspace-header"><div><p className="auth-kicker">FBEDS / AGENT PORTAL</p><h1>Workspace access</h1><p>Choose a verified workspace to continue.</p></div><AgentSignOut onComplete={() => window.location.reload()} /></header>
    <section className="workspace-card" aria-labelledby="workspace-title">
      <div className="workspace-card-heading"><div><span className="workspace-eyebrow">ACTIVE TENANT CONTEXT</span><h2 id="workspace-title">Select your workspace</h2></div><ShieldAlert aria-hidden="true" /></div>
      {identity.memberships.length === 0 && <div className="workspace-message warning" role="alert"><AlertTriangle size={18} /><p>Your account has no active workspaces. Contact your platform administrator.</p></div>}
      {identity.memberships.length > 1 && <p className="workspace-helper">Workspace access is verified server-side for every request. Switching workspace refreshes the active authorization context.</p>}
      <label className="workspace-select-label" htmlFor="active-workspace">Active workspace<select id="active-workspace" value={tenantId} onChange={(event) => setTenantId(event.target.value)} disabled={!identity.memberships.length}><option value="">Choose a workspace</option>{identity.memberships.map((membership) => <option key={membership.tenantId} value={membership.tenantId}>{membership.tenantName} · {membership.role}</option>)}</select><ChevronDown size={16} aria-hidden="true" /></label>
      {error && <div className="workspace-message warning" role="alert"><AlertTriangle size={18} /><p>{error}</p></div>}
      {tenantId && !error && <div className="workspace-status-grid"><div><span>Supplier status</span><strong className={`status-${providerStatus}`}>{providerStatus === 'checking' ? 'Checking connection…' : providerStatus === 'available' ? 'Live supplier connected' : 'Not configured'}</strong></div><div><span>Finance status</span><strong>{finance?.availableCredit == null ? 'Not configured' : `Available credit ${finance.availableCredit}`}</strong></div></div>}
    </section>
    {tenantId && !error && <AgentPortal key={tenantId} identity={identity} tenantId={tenantId} providerStatus={providerStatus} finance={finance} />}
  </main>
}
