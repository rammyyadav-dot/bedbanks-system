'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { users as allUsers } from '@/lib/mock'
import type { User } from '@/lib/types/admin'

export default function UsersPage() {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => allUsers.filter((u) =>
    u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()),
  ), [search])

  const columns: DataTableColumn<User>[] = [
    { key: 'name', header: 'Name', render: (u) => <Link href={`/users/${u.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{u.name}</Link> },
    { key: 'email', header: 'Email', render: (u) => u.email },
    { key: 'tenant', header: 'Tenant', render: (u) => u.tenantName },
    { key: 'role', header: 'Role', render: (u) => u.role },
    { key: 'lastActive', header: 'Last Active', render: (u) => (u.lastActive === '—' ? '—' : new Date(u.lastActive).toLocaleString()) },
    { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="BUSINESS · USERS" title="Users" description="All users across every tenant workspace." />
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search users by name or email…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(u) => u.id} emptyTitle="No users found" />
    </div>
  )
}
