'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
const accessSections = [
  ['Roles', 'Manage platform roles and their permission bundles.', '/access/roles'],
  ['Permissions', 'Review the canonical permission catalogue and scopes.', '/access/permissions'],
  ['Assignments', 'Grant and revoke platform roles with auditability.', '/access/assignments'],
] as const

export default function AccessPage() {
  const columns: DataTableColumn<(typeof accessSections)[number]>[] = [
    { key: '0', header: 'Area', render: (r) => <Link href={r[2]} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{r[0]}</Link> },
    { key: '1', header: 'Purpose', render: (r) => r[1] },
    { key: '2', header: 'Open', render: (r) => <Link href={r[2]} className="admin-btn">Open</Link> },
  ]
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="BUSINESS · ACCESS"
        title="Roles & Permissions"
        description="Governed platform access with database-backed permissions, role bundles, assignments, and audit trails."
      />
      <DataTable columns={columns} data={[...accessSections]} getRowId={(r) => r[0]} />
    </div>
  )
}
