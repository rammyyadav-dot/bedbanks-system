import { PageHeader } from '@/components/common/PageHeader'
import { roles, permissionResources } from '@/lib/mock'

const ACTIONS: Array<'read' | 'create' | 'edit' | 'delete'> = ['read', 'create', 'edit', 'delete']

export default function PermissionsPage() {
  return (
    <div className="admin-page">
      <PageHeader eyebrow="ACCESS · PERMISSIONS" title="Permission matrix" description="Mock UI representation of role permissions. This does not enforce authorization." />
      {roles.map((role) => (
        <div key={role.id} className="workspace-panel" style={{ marginBottom: 16 }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid #e6eef0', fontWeight: 700, color: '#17333e', fontSize: 13 }}>{role.name}</div>
          <table className="admin-matrix">
            <thead>
              <tr>
                <th>Resource</th>
                {ACTIONS.map((a) => <th key={a}>{a}</th>)}
              </tr>
            </thead>
            <tbody>
              {permissionResources.map((resource) => {
                const perm = role.permissions.find((p) => p.resource === resource)
                return (
                  <tr key={resource}>
                    <td>{resource}</td>
                    {ACTIONS.map((a) => <td key={a}>{perm?.actions.includes(a) ? <span className="yes">✓</span> : <span className="no">–</span>}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
