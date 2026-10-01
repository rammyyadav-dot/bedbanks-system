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
import { getRatePlans, type AdminRatePlan } from '@/lib/data'

const STATUS_OPTIONS = ['all', 'DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map((value) => ({ value, label: value === 'all' ? 'All statuses' : value }))

export default function RatePlansPage() {
  const can = useCan()
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    getRatePlans().then((rows) => { if (active) setPlans(rows) }).catch((cause) => { if (active) setError(describeApiError(cause, 'load rate plans')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return plans.filter((p) => (status === 'all' || p.status === status) && (!q || [p.code, p.roomType.hotel.name, p.roomType.name, p.contract.code, p.contract.supplier.displayName].some((value) => value.toLowerCase().includes(q))))
  }, [plans, search, status])
  const columns: DataTableColumn<AdminRatePlan>[] = [
    { key: 'code', header: 'Rate plan', render: (p) => <Link href={`/rates/plans/${p.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{p.code}</Link> },
    { key: 'hotel', header: 'Hotel', render: (p) => p.roomType.hotel.name },
    { key: 'room', header: 'Room', render: (p) => p.roomType.name },
    { key: 'board', header: 'Board', render: (p) => p.boardBasis.code.trim() },
    { key: 'contract', header: 'Contract', render: (p) => `${p.contract.code} · ${p.contract.supplier.displayName}` },
    { key: 'occupancy', header: 'Occ.', render: (p) => p.occupancy, align: 'right' },
    { key: 'currency', header: 'Currency', render: (p) => p.currency },
    { key: 'stay', header: 'Stay', render: (p) => p.maxStay == null ? `${p.minStay}+ nights` : `${p.minStay}–${p.maxStay} nights` },
    { key: 'release', header: 'Release', render: (p) => `${p.releaseDays}d`, align: 'right' },
    { key: 'status', header: 'Status', render: (p) => p.status },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · RATE PLANS" title="Rate Plans" description="Authoritative rate plans linking contract, room and board basis." actions={can('supply.rates.manage') ? <Link href="/rates/plans/new" className="admin-btn admin-btn-primary">New rate plan</Link> : undefined} />
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by code, hotel, room, contract or supplier…" />
        <SelectField label="Rate plan status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </TableToolbar>
      {loading ? <LoadingState rows={6} /> : error ? <ErrorState title="Rate plans unavailable" description={`${error} No fallback data is shown.`} /> : <DataTable columns={columns} data={filtered} getRowId={(p) => p.id} emptyTitle={plans.length === 0 ? 'No rate plans yet' : 'No rate plans match the filters'} emptyDescription={plans.length === 0 ? 'Create a contract first, then add a rate plan.' : 'Change the search or status filter.'} />}
    </div>
  )
}
