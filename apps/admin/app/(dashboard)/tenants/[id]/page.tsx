import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/status/StatusBadge'
import { Tabs } from '@/components/common/Tabs'
import { StatCard } from '@/components/common/StatCard'
import { getTenant, getUsers, getAuditEvents } from '@/lib/data'

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const tenant = await getTenant(id)
  if (!tenant) notFound()

  const [users, audit] = await Promise.all([getUsers(), getAuditEvents()])
  const tenantUsers = users.filter((u) => u.tenantId === tenant.id)
  const tenantAudit = audit.filter((a) => a.tenant === tenant.name)

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow={`TENANT · ${tenant.code}`}
        title={tenant.name}
        description={`${tenant.plan} plan · ${tenant.tier} tier · created ${tenant.createdAt}`}
        actions={<StatusBadge status={tenant.status} />}
      />
      <div className="admin-summary-cards">
        <StatCard label="Users" value={String(tenant.users)} />
        <StatCard label="Plan" value={tenant.plan} />
        <StatCard label="Tier" value={tenant.tier} />
        <StatCard label="Created" value={tenant.createdAt} />
      </div>
      <Tabs tabs={[
        { id: 'overview', label: 'Overview', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Tenant overview — mock summary. Real usage, wallet, and booking metrics arrive once <code>/api/v1/tenants/{tenant.id}</code> exists.</div> },
        { id: 'users', label: 'Users', content: (
          <div className="workspace-panel">
            {tenantUsers.length === 0 && <div style={{ padding: 20, fontSize: 12, color: '#7c949a' }}>No users found for this tenant.</div>}
            {tenantUsers.map((u) => (
              <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '1px solid #edf2f3', fontSize: 12 }}>
                <span>{u.name} <span style={{ color: '#8ba0a5' }}>· {u.email}</span></span>
                <span style={{ color: '#8ba0a5' }}>{u.role}</span>
              </div>
            ))}
          </div>
        ) },
        { id: 'settings', label: 'Settings', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Tenant settings form — UI-only placeholder.</div> },
        { id: 'activity', label: 'Activity', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>No live activity feed yet — connects to <code>/api/v1</code> later.</div> },
        { id: 'audit', label: 'Audit', content: (
          <div className="workspace-panel">
            {tenantAudit.length === 0 && <div style={{ padding: 20, fontSize: 12, color: '#7c949a' }}>No audit events recorded for this tenant.</div>}
            {tenantAudit.map((a) => (
              <div key={a.id} style={{ padding: '12px 18px', borderBottom: '1px solid #edf2f3', fontSize: 12 }}>
                <strong>{a.action}</strong> <span style={{ color: '#8ba0a5' }}>by {a.actor} · {new Date(a.timestamp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        ) },
      ]} />
    </div>
  )
}
