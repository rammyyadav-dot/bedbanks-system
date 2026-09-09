'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { tenants as allTenants } from '@/lib/mock'
import type { Tenant } from '@/lib/types/admin'

export default function TenantsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')

  const filtered = useMemo(() => allTenants.filter((t) =>
    (status === 'all' || t.status === status) &&
    t.name.toLowerCase().includes(search.toLowerCase()),
  ), [search, status])

  const columns: DataTableColumn<Tenant>[] = [
    { key: 'name', header: 'Tenant', render: (t) => <Link href={`/tenants/${t.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{t.name}</Link> },
    { key: 'code', header: 'Code', render: (t) => t.code },
    { key: 'tier', header: 'Plan / Tier', render: (t) => `${t.plan} · ${t.tier}` },
    { key: 'users', header: 'Users', render: (t) => t.users, align: 'right' },
    { key: 'createdAt', header: 'Created', render: (t) => t.createdAt },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  ]

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="BUSINESS · TENANTS"
        title="Tenants"
        description="Provision and monitor isolated B2B agency workspaces, commercial tiers, and status."
        actions={<Link href="/tenants/new" className="admin-btn admin-btn-primary"><Plus size={14} />Add tenant</Link>}
      />
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search tenants…" />
        <SelectField label="Status" value={status} onChange={setStatus} options={[
          { value: 'all', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' }, { value: 'suspended', label: 'Suspended' },
        ]} />
      </TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(t) => t.id} emptyTitle="No tenants found" />
    </div>
  )
}
