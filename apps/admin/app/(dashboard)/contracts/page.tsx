'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { getContracts, type AdminContract } from '@/lib/data'

const STATUS_OPTIONS = ['all', 'DRAFT', 'REVIEW', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map((value) => ({ value, label: value === 'all' ? 'All statuses' : value }))

export default function ContractsPage() {
  const can = useCan()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [contracts, setContracts] = useState<AdminContract[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    getContracts().then((rows) => { if (active) setContracts(rows) }).catch((cause) => { if (active) setError(describeApiError(cause, 'load contracts')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return contracts.filter((c) => (status === 'all' || c.status === status) && (!q || c.code.toLowerCase().includes(q) || c.supplier.displayName.toLowerCase().includes(q)))
  }, [contracts, search, status])

  const columns: DataTableColumn<AdminContract>[] = [
    { key: 'code', header: 'Contract', render: (c) => <Link href={`/contracts/${c.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{c.code}</Link> },
    { key: 'supplier', header: 'Supplier', render: (c) => c.supplier.displayName },
    { key: 'validity', header: 'Validity', render: (c) => `${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)}` },
    { key: 'currency', header: 'Currency', render: (c) => c.settlementCurrency },
    { key: 'mapping', header: 'Hotel binding', render: (c) => c.supplierHotelMapping ? `${c.supplierHotelMapping.status}` : 'Unbound' },
    { key: 'status', header: 'Status', render: (c) => c.status },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · CONTRACTS" title="Contracts" description="Authoritative commercial terms per supplier relationship." actions={can('supply.contracts.manage') ? <Link href="/contracts/new" className="admin-btn admin-btn-primary">New contract</Link> : undefined} />
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by code or supplier…" />
        <SelectField label="Contract status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </TableToolbar>
      {loading ? <LoadingState rows={6} /> : error ? <ErrorState title="Contracts unavailable" description={`${error} No fallback data is shown.`} /> : <DataTable columns={columns} data={filtered} getRowId={(c) => c.id} emptyTitle={contracts.length === 0 ? 'No contracts yet' : 'No contracts match the filters'} emptyDescription={contracts.length === 0 ? 'Create the first contract to start building rate plans.' : 'Change the search or status filter.'} />}
    </div>
  )
}
