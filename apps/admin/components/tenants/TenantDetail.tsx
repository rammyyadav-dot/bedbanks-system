'use client'

import Link from 'next/link'
import { useEffect, useState, type FormEvent } from 'react'
import { routes, type TenantBusiness } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { tenantApiPath, tenantUsersPath } from '@/lib/tenants-ui'
import { BusinessFields, emptyBusiness } from './BusinessFields'
import { TenantShell } from './TenantShell'
import { useTenantControl } from './useTenantControl'

const tabs = [
  ['overview', 'Overview'],
  ['profile', 'Business profile'],
  ['commercial', 'Commercial'],
  ['finance', 'Finance & credit'],
  ['operations', 'Operations'],
  ['compliance', 'Compliance'],
  ['settings', 'Workspace settings'],
  ['audit', 'Audit & activity'],
] as const

interface AuditPage {
  items: { id: string; action: string; userId: string | null; entityType: string; createdAt: string }[]
  total: number
  page: number
  pageSize: number
}

function facts(values: Record<string, unknown>) {
  return (
    <dl className="tenant-facts">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
          <dd>{Array.isArray(value) ? value.join(', ') || 'Unconfigured' : typeof value === 'boolean' ? value ? 'Reviewed' : 'Pending' : value == null ? 'Unavailable' : String(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function TenantDetail({ id }: { id: string }) {
  const { data, error, notice, busy, load, mutate, can } = useTenantControl(id)
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('overview')
  const [editing, setEditing] = useState(false)
  const [business, setBusiness] = useState<TenantBusiness>(emptyBusiness)
  const [reason, setReason] = useState('')
  const [audit, setAudit] = useState<AuditPage | null>(null)
  const [auditError, setAuditError] = useState('')
  const [auditFilters, setAuditFilters] = useState({ action: '', actor: '', entityType: '', from: '', to: '', page: 1 })

  useEffect(() => {
    if (data) setBusiness(data.profile?.business ?? { ...emptyBusiness, name: data.tenant.name })
  }, [data])

  useEffect(() => {
    if (tab !== 'audit' || !data) return
    let valid = true
    const timer = setTimeout(async () => {
      const query = new URLSearchParams()
      Object.entries(auditFilters).forEach(([key, value]) => { if (value !== '') query.set(key, String(value)) })
      setAuditError('')
      try {
        const page = await apiRequest<AuditPage>(`${tenantApiPath(routes.platform.tenantAudit, id)}?${query}`)
        if (valid) setAudit(page)
      } catch (cause) {
        if (valid) {
          setAudit(null)
          setAuditError(cause instanceof Error ? cause.message : 'Audit unavailable')
        }
      }
    }, 200)
    return () => { valid = false; clearTimeout(timer) }
  }, [id, tab, auditFilters, data])

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (await mutate(routes.platform.tenantProfile, { business, version: data?.profile?.version ?? 0 }, 'PATCH')) setEditing(false)
  }

  async function lifecycle(event: FormEvent) {
    event.preventDefault()
    if (await mutate(routes.platform.tenantLifecycle, { status: data?.tenant.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE', reason, version: data?.profile?.version ?? 0 })) setReason('')
  }

  const version = data?.profile?.version ?? 0
  const readiness = data && (
    <ul className="tenant-readiness">
      {data.readiness.map((item) => (
        <li key={item.key}>
          <span className={`tenant-check ${item.ready ? 'ready' : ''}`}>{item.ready ? '✓' : '!'}</span>
          <span>{item.label}</span>
          {!item.ready && item.remediation === 'members' && <Link className="tenant-text-button" href={tenantUsersPath(id)}>Review</Link>}
          {!item.ready && item.remediation !== 'members' && <button type="button" className="tenant-text-button" onClick={() => setTab(item.remediation as (typeof tabs)[number][0])}>Review</button>}
        </li>
      ))}
    </ul>
  )

  return (
    <TenantShell
      id={id}
      title={data?.tenant.name ?? 'Tenant'}
      description={data ? `${data.tenant.slug} · ${data.profile?.business.country ?? 'Country unrecorded'} · ${data.tenant.status}` : ''}
      data={data}
      error={error}
      notice={notice}
      onRetry={() => void load()}
      actions={<Link href="/tenants" className="admin-btn">Back to directory</Link>}
    >
      {data && (
        <>
          <div
            className="tenant-tabs"
            role="tablist"
            aria-label="Tenant settings"
            onKeyDown={(event) => {
              const index = tabs.findIndex(([key]) => key === tab)
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault()
                const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
                setTab(tabs[next]![0])
                document.getElementById(`tenant-tab-${tabs[next]![0]}`)?.focus()
              }
            }}
          >
            {tabs.map(([key, label]) => (
              <button type="button" role="tab" id={`tenant-tab-${key}`} aria-controls="tenant-panel" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} key={key} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <section id="tenant-panel" role="tabpanel" aria-labelledby={`tenant-tab-${tab}`} className="tenant-panel tenant-detail-panel">
            {tab === 'overview' && (
              <>
                <div className="tenant-kpis">{Object.entries(data.counts).map(([key, value]) => <div key={key} className="tenant-kpi"><span>{key.replace(/([A-Z])/g, ' $1')}</span><strong>{value ?? 'Unavailable'}</strong></div>)}</div>
                <h2>Activation readiness</h2>
                {readiness}
                <p className="tenant-note">Tenant activation is separate from hotel publication and rate-plan activation. Users and access live on the Users & access page.</p>
              </>
            )}
            {tab === 'profile' && (
              <>
                <div className="tenant-panel-head">
                  <h2>Business profile</h2>
                  {can('platform.tenants.manage') && <button type="button" className="admin-btn tenant-primary" onClick={() => setEditing(true)}>Edit profile</button>}
                </div>
                {data.profile ? facts(data.profile.business as unknown as Record<string, unknown>) : <p>No business profile is recorded. Complete the profile before activation.</p>}
              </>
            )}
            {tab === 'commercial' && (
              <>
                <h2>Commercial configuration</h2>
                {facts(data.commercial)}
                {data.profile && facts({ classification: data.profile.business.classification, currency: data.profile.business.currency, markets: data.profile.business.markets, channels: data.profile.business.channels, markupPolicyReference: data.profile.business.markupPolicyReference })}
                <p className="tenant-note">These are business preferences and authoritative record counts. Distribution, contract and markup changes require their canonical tenant-scoped services. Supplier and hybrid activation remains blocked pending a certified entitlement workflow.</p>
              </>
            )}
            {tab === 'finance' && (
              <>
                <h2>Finance & credit</h2>
                <p>{data.finance.message}</p>
                <p className="tenant-note">No balance, exposure, or credit is inferred from profile data. Finance eligibility review does not grant a credit facility. Agency credit limits remain in Agencies.</p>
              </>
            )}
            {tab === 'operations' && (
              <>
                <h2>Lifecycle governance</h2>
                {readiness}
                <p className="tenant-note">Requests need a reason and a different platform approver. Suspension restricts new trade; financial, contractual and audit records are retained. Closure requires a retention policy and is unavailable.</p>
                {can('platform.tenants.lifecycle.request') && (
                  <form className="tenant-inline-form" onSubmit={lifecycle}>
                    <label>Reason<input required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                    <button type="submit" className="admin-btn tenant-primary" disabled={busy}>Request {data.tenant.status === 'ACTIVE' ? 'suspension' : 'activation'}</button>
                  </form>
                )}
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead><tr><th>Requested transition</th><th>Reason</th><th>Status</th><th>Decision</th></tr></thead>
                    <tbody>
                      {data.approvals.map((approval) => (
                        <tr key={approval.id}>
                          <td>{(approval.proposedState as { status?: string })?.status ?? '—'}</td>
                          <td>{approval.reason}</td>
                          <td>{approval.status}</td>
                          <td>
                            {can('platform.tenants.lifecycle.approve') && ['PENDING', 'APPROVED'].includes(approval.status) ? (
                              <div className="tenant-actions">
                                <button type="button" className="admin-btn" disabled={busy} onClick={() => { const text = window.prompt('Approval reason (at least 3 characters)'); if (text) void mutate(routes.platform.tenantApproval, { decision: 'APPROVED', reason: text }, 'POST', { approvalId: approval.id }) }}>{approval.status === 'APPROVED' ? 'Execute approved request' : 'Approve & execute'}</button>
                                {approval.status === 'PENDING' && <button type="button" className="admin-btn" disabled={busy} onClick={() => { const text = window.prompt('Rejection reason'); if (text) void mutate(routes.platform.tenantApproval, { decision: 'REJECTED', reason: text }, 'POST', { approvalId: approval.id }) }}>Reject</button>}
                              </div>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {tab === 'compliance' && (
              <>
                <h2>Compliance & verification</h2>
                {facts({ status: data.profile?.complianceStatus ?? 'Unrecorded', registrationNumber: data.profile?.business.registrationNumber, taxNumber: data.profile?.business.taxNumber })}
                <p className="tenant-note">Business identity changes invalidate previous approval. The editor cannot approve their own submission. Private document storage is not yet configured.</p>
                {can('platform.tenants.compliance.approve') && data.profile && (
                  <div className="tenant-actions">
                    {(['APPROVED', 'REJECTED'] as const).map((decision) => (
                      <button type="button" key={decision} className="admin-btn" disabled={busy} onClick={() => { const text = window.prompt('Verification decision reason'); if (text) void mutate(routes.platform.tenantCompliance, { decision, reason: text, version }) }}>{decision === 'APPROVED' ? 'Approve compliance' : 'Reject compliance'}</button>
                    ))}
                  </div>
                )}
              </>
            )}
            {tab === 'settings' && (
              <>
                <h2>Workspace settings</h2>
                {data.settings ? facts({ ...data.settings, lowBalanceThreshold: `${data.settings.lowBalanceThreshold.amountMinor} minor units ${data.settings.lowBalanceThreshold.currency}` }) : <p>Workspace preferences have not been configured.</p>}
                <p className="tenant-note">Settings changes require an active, verified membership and settings.manage in that same tenant. The global Settings page uses your authenticated membership context.</p>
              </>
            )}
            {tab === 'audit' && (
              <>
                <h2>Audit & activity</h2>
                {can('platform.tenants.audit.read') ? (
                  <>
                    <div className="tenant-filters">
                      {(['action', 'actor', 'entityType', 'from', 'to'] as const).map((key) => (
                        <label key={key}>{key === 'actor' ? 'Actor ID' : key}<input type={key === 'from' || key === 'to' ? 'date' : 'text'} value={auditFilters[key]} onChange={(event) => setAuditFilters((current) => ({ ...current, [key]: event.target.value, page: 1 }))} /></label>
                      ))}
                    </div>
                    {auditError && <p role="alert" className="tenant-error">{auditError}</p>}
                    <ol className="tenant-timeline">
                      {audit?.items.map((event) => (
                        <li key={event.id}><strong>{event.action}</strong><span>{event.entityType} · {event.userId ?? 'System'}</span><time>{new Date(event.createdAt).toLocaleString()}</time></li>
                      ))}
                    </ol>
                    <div className="tenant-pager">
                      <span>{audit?.total ?? '—'} events</span>
                      <button type="button" className="admin-btn" disabled={auditFilters.page === 1} onClick={() => setAuditFilters((current) => ({ ...current, page: current.page - 1 }))}>Previous</button>
                      <button type="button" className="admin-btn" disabled={!audit || audit.page * 25 >= audit.total} onClick={() => setAuditFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</button>
                    </div>
                  </>
                ) : <p>platform.tenants.audit.read is required to view immutable events.</p>}
              </>
            )}
          </section>
          {editing && (
            <div className="tenant-modal-backdrop">
              <section
                className="tenant-modal tenant-drawer"
                role="dialog"
                aria-modal="true"
                aria-labelledby="edit-title"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !busy) setEditing(false)
                  if (event.key !== 'Tab') return
                  const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]'))
                  const first = nodes[0]
                  const last = nodes[nodes.length - 1]
                  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
                  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
                }}
              >
                <div className="tenant-panel-head"><h2 id="edit-title">Edit business profile</h2><button type="button" className="admin-btn" onClick={() => setEditing(false)} disabled={busy} autoFocus>Close</button></div>
                <form onSubmit={saveProfile}>
                  <BusinessFields value={business} onChange={setBusiness} />
                  {error && <p className="tenant-error" role="alert">{error}</p>}
                  <div className="tenant-actions"><button type="submit" className="admin-btn tenant-primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button></div>
                </form>
              </section>
            </div>
          )}
        </>
      )}
    </TenantShell>
  )
}
