'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { roles } from '@/lib/mock'
import type { Role } from '@/lib/types/admin'

export default function AccessPage() {
  const columns: DataTableColumn<Role>[] = [
    { key: 'name', header: 'Role', render: (r) => <Link href="/access/roles" style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{r.name}</Link> },
    { key: 'description', header: 'Description', render: (r) => r.description },
    { key: 'userCount', header: 'Users', render: (r) => r.userCount, align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="BUSINESS · ACCESS"
        title="Roles & Permissions"
        description="UI-only visualization of the access model. Backend authorization is enforced in P0-F."
        actions={<div style={{ display: 'flex', gap: 8 }}><Link href="/access/roles" className="admin-btn">Roles</Link><Link href="/access/permissions" className="admin-btn">Permission matrix</Link></div>}
      />
      <DataTable columns={columns} data={roles} getRowId={(r) => r.id} />
    </div>
  )
}
