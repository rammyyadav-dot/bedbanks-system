'use client'

import { useEffect, useState } from 'react'
import type { AgentIdentity } from '@/lib/api-client'
import type { Quotation, QuotationLineItemInput } from '@bedbanks/contracts/agent'
import { getQuotation } from '@/lib/api-client'
import { QuotationBuilder } from './quotation-builder'

/**
 * Resolves the agent's active tenant the same way the workspace does (auto-select on a single membership, otherwise
 * ask) before mounting the quotation builder for it. Tenant identity never comes from a query string or the
 * browser; it comes from the authenticated memberships the server returned (CLAUDE.md invariant 1).
 */
export function QuotationPageShell({ identity, quotationId, initialLineItems = [], currency = 'AED' }: {
  identity: AgentIdentity
  quotationId?: string
  initialLineItems?: QuotationLineItemInput[]
  currency?: string
}) {
  const [tenantId, setTenantId] = useState(identity.memberships.length === 1 ? identity.memberships[0].tenantId : '')
  const [existing, setExisting] = useState<Quotation | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(Boolean(quotationId))

  useEffect(() => {
    if (!tenantId || !quotationId) { setLoading(false); return }
    let active = true
    setLoading(true)
    getQuotation(tenantId, quotationId)
      .then((quotation) => { if (active) { setExisting(quotation); setLoading(false) } })
      .catch((err) => { if (active) { setLoadError(err instanceof Error ? err.message : 'Could not load this quotation'); setLoading(false) } })
    return () => { active = false }
  }, [tenantId, quotationId])

  if (!tenantId) {
    return <main className="trade-state" aria-labelledby="bb-quote-tenant-title">
      <h1 id="bb-quote-tenant-title">Choose a workspace</h1>
      <ul className="bb-quote-tenant-list">
        {identity.memberships.map((membership) => (
          <li key={membership.tenantId}>
            <button type="button" onClick={() => setTenantId(membership.tenantId)}>{membership.tenantName}</button>
          </li>
        ))}
      </ul>
    </main>
  }

  if (loading) return <main className="trade-state" aria-live="polite"><p>Loading quotation…</p></main>
  if (loadError) return <main className="trade-state"><p className="bb-field-error">{loadError}</p></main>

  return <main className="bb-quote-page">
    <QuotationBuilder tenantId={tenantId} currency={existing?.currency ?? currency} initialLineItems={initialLineItems} existing={existing ?? undefined} />
  </main>
}
