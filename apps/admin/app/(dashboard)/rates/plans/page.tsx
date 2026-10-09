'use client'

import { useEffect, useState } from 'react'
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
import { getRatePlanPortfolio, type AdminRatePlan } from '@/lib/data'

const STATUS_OPTIONS = ['all', 'DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map((value) => ({ value, label: value === 'all' ? 'All statuses' : value }))

export default function RatePlansPage() {
  const can = useCan()
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setLoading(true); setError(null)
    const timer = setTimeout(() => {
      getRatePlanPortfolio({ search, status: status === 'all' ? undefined : status, page, pageSize: 25 })
        .then((result) => { if (active) { setPlans(result.items); setTotal(result.total); setHasMore(result.hasMore) } })
        .catch((cause) => { if (active) setError(describeApiError(cause, 'load rate plans')) })
        .finally(() => { if (active) setLoading(false) })
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [search, status, page])
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
        <SearchInput value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search by code, hotel or supplier…" />
        <SelectField label="Rate plan status" value={status} onChange={(value) => { setStatus(value); setPage(1) }} options={STATUS_OPTIONS} />
      </TableToolbar>
      {loading ? <LoadingState rows={6} /> : error ? <ErrorState title="Rate plans unavailable" description={`${error} No fallback data is shown.`} /> : <DataTable columns={columns} data={plans} getRowId={(p) => p.id} emptyTitle={plans.length === 0 ? 'No rate plans yet' : 'No rate plans match the filters'} emptyDescription={plans.length === 0 ? 'Create a contract first, then add a rate plan.' : 'Change the search or status filter.'} />}
      {!loading && !error ? <nav aria-label="Rate plan pagination" className="admin-filter-bar">
        <span>{total === 0 ? 'No matching rate plans' : `${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} of ${total} rate plans`}</span>
        <button className="admin-btn" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
        <button className="admin-btn" disabled={!hasMore} onClick={() => setPage(page + 1)}>Next</button>
      </nav> : null}
    </div>
  )
}
