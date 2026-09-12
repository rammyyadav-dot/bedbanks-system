'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { DetailDrawer, DrawerField } from '@/components/dialogs/DetailDrawer'
import { roles } from '@/lib/mock'
import type { Role } from '@/lib/types/admin'

export default function RolesPage() {
  const [selected, setSelected] = useState<Role | null>(null)
  const columns: DataTableColumn<Role>[] = [
    { key: 'name', header: 'Role', render: (r) => r.name },
    { key: 'description', header: 'Description', render: (r) => r.description },
    { key: 'userCount', header: 'Users', render: (r) => r.userCount, align: 'right' },
    { key: 'permissions', header: 'Permissions', render: (r) => r.permissions.filter((p) => p.actions.length > 0).length, align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="ACCESS · ROLES" title="Roles" description="Click a row to view assigned users and permissions." />
      <DataTable columns={columns} data={roles} getRowId={(r) => r.id} onRowClick={setSelected} />
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} title={selected?.name ?? ''} subtitle={selected?.description}>
        {selected && (
          <>
            <DrawerField label="Assigned users" value={selected.userCount} />
            <DrawerField label="Status" value={<StatusBadge status={selected.status} />} />
            <div style={{ marginTop: 16, fontSize: 10, color: '#7c949a', fontFamily: "'Courier New', monospace", letterSpacing: '.6px' }}>PERMISSIONS</div>
            {selected.permissions.map((p) => (
              <div key={p.id} className="admin-drawer-field"><span>{p.resource}</span><span>{p.actions.length ? p.actions.join(', ') : 'No access'}</span></div>
            ))}
          </>
        )}
      </DetailDrawer>
    </div>
  )
}
