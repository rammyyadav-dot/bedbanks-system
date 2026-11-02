'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Building2, Plus, Search } from 'lucide-react'
import { routes, type TenantDirectory as Directory } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { PageHeader } from '@/components/common/PageHeader'
import {
  TENANT_LIFECYCLE_FILTERS,
  canCreateTenant,
  tenantDirectoryQuery,
  tenantLifecycleClass,
  tenantLifecycleLabel,
  tenantPath,
  tenantUsersPath,
  type TenantLifecycleFilter,
} from '@/lib/tenants-ui'

export function TenantDirectory() {
  const [data, setData] = useState<Directory | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [filters, setFilters] = useState({
    search: '', lifecycle: '' as TenantLifecycleFilter, classification: '', country: '',
    createdFrom: '', createdTo: '', sort: 'name', order: 'asc', page: 1,
  })

  useEffect(() => {
    let valid = true
    const timer = setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const next = await apiRequest<Directory>(`${routes.platform.tenants}?${tenantDirectoryQuery(filters)}`)
        if (valid) setData(next)
      } catch (cause) {
        if (valid) {
          setData(null)
          setError(cause instanceof Error ? cause.message : 'Tenant directory unavailable')
        }
      } finally {
        if (valid) setLoading(false)
      }
    }, 200)
    return () => { valid = false; clearTimeout(timer) }
  }, [filters, retry])

  const set = (key: string, value: string) => setFilters((current) => ({ ...current, [key]: value, page: 1 }))
  const metricLabels: Record<string, string> = {
    total: 'Total tenants', active: 'Active tenants', pendingReview: 'Pending approval',
    suspended: 'Suspended tenants', newThisMonth: 'Created this month', incomplete: 'Incomplete profiles',
  }

  return (
    <div className="admin-page tenant-control">
      <PageHeader
        eyebrow="BUSINESS"
        title="Tenants"
        description="Search and monitor onboarded B2B travel agency tenants. Credit limits and wallets are not returned by tenant control; they remain in Agencies and Finance."
        actions={data && canCreateTenant(data) ? <Link href="/tenants/new" className="admin-btn tenant-primary"><Plus size={15} />Register tenant</Link> : undefined}
      />
      {data && (
        <div className="tenant-kpis">
          {Object.entries(data.metrics).map(([key, value]) => (
            <div className="tenant-kpi" key={key}><span>{metricLabels[key]}</span><strong>{value ?? 'Unavailable'}</strong></div>
          ))}
        </div>
      )}
      <section className="tenant-panel">
        <div className="tenant-panel-head">
          <div className="tenant-section-title"><Building2 size={17} /><h2>Tenant directory</h2></div>
          <span>{data?.total ?? '—'} businesses</span>
        </div>
        <div className="tenant-filters">
          <label className="tenant-search"><span><Search size={14} />Search tenants</span><input placeholder="Business name or tenant code" value={filters.search} onChange={(event) => set('search', event.target.value)} /></label>
          <label>Status
            <select value={filters.lifecycle} onChange={(event) => set('lifecycle', event.target.value)}>
              {TENANT_LIFECYCLE_FILTERS.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>Business type
            <select value={filters.classification} onChange={(event) => set('classification', event.target.value)}>
              <option value="">All types</option><option>BUYER</option><option>SUPPLIER</option><option>HYBRID</option>
            </select>
          </label>
          <label>Country<input placeholder="ISO code" maxLength={2} value={filters.country} onChange={(event) => set('country', event.target.value.toUpperCase())} /></label>
          <label>Created from<input type="date" value={filters.createdFrom} onChange={(event) => set('createdFrom', event.target.value)} /></label>
          <label>Created to<input type="date" value={filters.createdTo} onChange={(event) => set('createdTo', event.target.value)} /></label>
          <label>Sort
            <select value={`${filters.sort}:${filters.order}`} onChange={(event) => {
              const [sort, order] = event.target.value.split(':')
              setFilters((current) => ({ ...current, sort, order, page: 1 }))
            }}>
              <option value="name:asc">Name A–Z</option>
              <option value="name:desc">Name Z–A</option>
              <option value="createdAt:desc">Newest first</option>
              <option value="createdAt:asc">Oldest first</option>
            </select>
          </label>
        </div>
        {error && <div className="tenant-error" role="alert">{error}<button type="button" className="admin-btn" onClick={() => setRetry(retry + 1)}>Retry</button></div>}
        <div className="admin-table-wrap" aria-busy={loading}>
          <table className="admin-table">
            <thead>
              <tr>{['Tenant', 'Business type', 'Country', 'Status', 'Members', 'Credit / wallet', 'Created', 'Last activity', 'Actions'].map((header) => <th key={header}>{header}</th>)}</tr>
            </thead>
            <tbody>
              {data?.items.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <Link className="tenant-name" href={tenantPath(tenant.id)}>{tenant.name}</Link>
                    <small className="tenant-code">{tenant.slug}</small>
                  </td>
                  <td>{tenant.profile?.classification ?? 'Unclassified'}</td>
                  <td>{tenant.profile?.country ?? '—'}</td>
                  <td><span className={`tenant-status ${tenantLifecycleClass(tenant.status, tenant.profile?.stage)}`}>{tenantLifecycleLabel(tenant.status, tenant.profile?.stage)}</span></td>
                  <td>{tenant.members ?? '—'}</td>
                  <td><span className="tenant-muted">Unavailable here</span><small className="tenant-code">See Agencies</small></td>
                  <td>{new Date(tenant.createdAt).toLocaleDateString('en-GB')}</td>
                  <td>{tenant.lastActivity ? new Date(tenant.lastActivity).toLocaleDateString('en-GB') : 'Unavailable'}</td>
                  <td>
                    <Link className="admin-btn" href={tenantPath(tenant.id)}>Open</Link>
                    {' '}
                    <Link className="admin-btn" href={tenantUsersPath(tenant.id)}>Users</Link>
                  </td>
                </tr>
              ))}
              {loading && !data && <tr><td colSpan={9}>Loading tenant directory…</td></tr>}
              {!loading && data && !data.items.length && <tr><td colSpan={9}>No tenants match these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="tenant-pager">
          <span aria-live="polite">{loading ? 'Updating…' : `Page ${data?.page ?? 1} of ${Math.max(1, Math.ceil((data?.total ?? 0) / (data?.pageSize ?? 25)))}`}</span>
          <button type="button" className="admin-btn" disabled={loading || filters.page === 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Previous</button>
          <button type="button" className="admin-btn" disabled={loading || !data || data.page * data.pageSize >= data.total} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</button>
        </div>
      </section>
    </div>
  )
}
