'use client'

import { useEffect, useState } from 'react'
import { AgentPortal } from './agent-portal'
import { getFinanceSummary, getSearchStatus, type AgentIdentity } from '@/lib/api-client'

export function AgentWorkspace({ identity }: { identity: AgentIdentity }) {
  const [tenantId, setTenantId] = useState(identity.memberships[0]?.tenantId ?? '')
  const [finance, setFinance] = useState<{ status: string; availableCredit: number | null } | null>(null)
  const [providerStatus, setProviderStatus] = useState<'checking' | 'available' | 'unavailable'>('checking')

  useEffect(() => {
    if (!tenantId) return
    Promise.all([getFinanceSummary(tenantId), getSearchStatus(tenantId)])
      .then(([financeSummary, status]) => { setFinance(financeSummary); setProviderStatus(status.status === 'available' ? 'available' : 'unavailable') })
      .catch(() => { setFinance(null); setProviderStatus('unavailable') })
  }, [tenantId])

  return <>
    <div className="agent-context-bar" role="region" aria-label="Workspace context">
      <label>Workspace<select aria-label="Active workspace" value={tenantId} onChange={(event) => setTenantId(event.target.value)}>{identity.memberships.map((membership) => <option key={membership.tenantId} value={membership.tenantId}>{membership.tenantName} · {membership.role}</option>)}</select></label>
      <span className={`agent-provider-status ${providerStatus}`}>{providerStatus === 'checking' ? 'Checking supplier' : providerStatus === 'available' ? 'Live supplier connected' : 'Supplier not configured'}</span>
      <span className="agent-credit-status">{finance?.availableCredit == null ? 'Credit ledger not configured' : `Available credit ${finance.availableCredit}`}</span>
    </div>
    <AgentPortal />
  </>
}
