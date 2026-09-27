'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { getSuppliers, type SupplySupplier } from '@/lib/data'
import type { Status } from '@/lib/types/admin'

const supplierStatus = (status: string): Status => status === 'ACTIVE' ? 'active' : status === 'SUSPENDED' ? 'suspended' : status === 'INACTIVE' ? 'inactive' : 'pending'

export default function SuppliersPage() {
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<SupplySupplier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      setLoading(true); setError(false)
      const query = new URLSearchParams({ page: '1', pageSize: '100' })
      if (search.trim()) query.set('search', search.trim())
      getSuppliers(query.toString()).then(result => { if (active) setItems(result.items) }).catch(() => { if (active) setError(true) }).finally(() => { if (active) setLoading(false) })
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [search])

  const columns = useMemo<DataTableColumn<SupplySupplier>[]>(() => [
    { key: 'displayName', header: 'Supplier', render: (s) => <Link href={`/suppliers/${s.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{s.displayName}</Link> },
    { key: 'legalName', header: 'Legal Name', render: (s) => s.legalName },
    { key: 'type', header: 'Type', render: (s) => s.type.replaceAll('_', ' ') },
    { key: 'countryCode', header: 'Country', render: (s) => s.countryCode },
    { key: 'currency', header: 'Currency', render: (s) => s.defaultCurrency },
    { key: 'updatedAt', header: 'Updated', render: (s) => new Date(s.updatedAt).toLocaleString() },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={supplierStatus(s.status)} /> },
  ], [])

  return (
    <div className="admin-page">
      <PageHeader eyebrow="SUPPLIERS" title="Suppliers" description="Authoritative supplier relationships for the active tenant." />
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search suppliers…" /></TableToolbar>
      {loading ? <LoadingState rows={6} /> : error ? <ErrorState title="Supplier data unavailable" description="The Admin API could not load authoritative supplier data. No fallback data is shown." /> : <DataTable columns={columns} data={items} getRowId={(s) => s.id} emptyTitle="No suppliers found" />}
    </div>
  )
}
