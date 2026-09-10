import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { StatusBadge } from '@/components/status/StatusBadge'
import { Tabs } from '@/components/common/Tabs'
import { getUser, getAuditEvents } from '@/lib/data'

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getUser(id)
  if (!user) notFound()
  const audit = (await getAuditEvents()).filter((a) => a.actor === user.name)

  return (
    <div className="admin-page">
      <PageHeader eyebrow={`USER · ${user.tenantName}`} title={user.name} description={user.email} actions={<StatusBadge status={user.status} />} />
      <Tabs tabs={[
        { id: 'profile', label: 'Profile', content: (
          <div className="workspace-panel" style={{ padding: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, fontSize: 12 }}>
              <div><span style={{ color: '#8ba0a5' }}>Email</span><div style={{ fontWeight: 600 }}>{user.email}</div></div>
              <div><span style={{ color: '#8ba0a5' }}>Role</span><div style={{ fontWeight: 600 }}>{user.role}</div></div>
              <div><span style={{ color: '#8ba0a5' }}>Tenant</span><div style={{ fontWeight: 600 }}>{user.tenantName}</div></div>
              <div><span style={{ color: '#8ba0a5' }}>Created</span><div style={{ fontWeight: 600 }}>{user.createdAt}</div></div>
            </div>
          </div>
        ) },
        { id: 'memberships', label: 'Tenant Memberships', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>{user.name} belongs to <strong>{user.tenantName}</strong> as <strong>{user.role}</strong>. Multi-tenant membership UI arrives with real membership data.</div> },
        { id: 'roles', label: 'Roles', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Assigned role: <strong>{user.role}</strong>.</div> },
        { id: 'activity', label: 'Activity', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Last active: {user.lastActive === '—' ? 'never' : new Date(user.lastActive).toLocaleString()}.</div> },
        { id: 'audit', label: 'Audit', content: (
          <div className="workspace-panel">
            {audit.length === 0 && <div style={{ padding: 20, fontSize: 12, color: '#7c949a' }}>No audit events recorded for this user.</div>}
            {audit.map((a) => (
              <div key={a.id} style={{ padding: '12px 18px', borderBottom: '1px solid #edf2f3', fontSize: 12 }}>
                <strong>{a.action}</strong> <span style={{ color: '#8ba0a5' }}>· {new Date(a.timestamp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        ) },
      ]} />
    </div>
  )
}
