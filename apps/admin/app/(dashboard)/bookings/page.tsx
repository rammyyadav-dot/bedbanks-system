'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { bookings as allBookings } from '@/lib/mock'
import type { Booking } from '@/lib/types/admin'

const STATUS_CLASS: Record<Booking['status'], string> = { confirmed: 'success', pending: 'warning', failed: 'danger', cancelled: 'neutral' }

export default function BookingsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const filtered = useMemo(() => allBookings.filter((b) =>
    (status === 'all' || b.status === status) && b.reference.toLowerCase().includes(search.toLowerCase()),
  ), [search, status])

  const columns: DataTableColumn<Booking>[] = [
    { key: 'reference', header: 'Reference', render: (b) => <Link href={`/bookings/${b.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{b.reference}</Link> },
    { key: 'tenant', header: 'Tenant', render: (b) => b.tenant },
    { key: 'agent', header: 'Agent', render: (b) => b.agent },
    { key: 'hotel', header: 'Hotel', render: (b) => b.hotel },
    { key: 'dates', header: 'Check-in / out', render: (b) => `${b.checkIn} → ${b.checkOut}` },
    { key: 'supplier', header: 'Supplier', render: (b) => b.supplier },
    { key: 'amount', header: 'Amount', render: (b) => `${b.currency} ${b.amount.toFixed(2)}`, align: 'right' },
    { key: 'status', header: 'Status', render: (b) => <span className={`status-pill ${STATUS_CLASS[b.status]}`}><i className="status-dot" />{b.status}</span> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="BOOKINGS" title="All Bookings" description="Every booking across every tenant and supplier." />
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by reference…" />
        <SelectField label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, { value: 'confirmed', label: 'Confirmed' }, { value: 'pending', label: 'Pending' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' }]} />
      </TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(b) => b.id} emptyTitle="No bookings found" />
    </div>
  )
}
