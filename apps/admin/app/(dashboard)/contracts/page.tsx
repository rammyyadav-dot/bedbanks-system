'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { useCan } from '@/lib/auth/capabilities'
import { getContractPortfolio, type AdminContract } from '@/lib/data'

const STATUSES = ['DRAFT', 'REVIEW', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map((value) => ({ value, label: value }))

/** Search, status filter, sort and pagination all run on the API, so the page never holds the whole contract book in memory. */
export default function ContractsPage() {
  const can = useCan()
  return (
    <OpsListPage<AdminContract>
      eyebrow="COMMERCIAL · CONTRACTS" title="Contracts" description="Authoritative commercial terms per supplier relationship."
      actions={can('supply.contracts.manage') ? <Link href="/contracts/new" className="admin-btn admin-btn-primary">New contract</Link> : undefined}
      filters={[
        { key: 'search', label: 'Search', type: 'text', placeholder: 'Code or supplier…' },
        { key: 'status', label: 'Status', type: 'select', options: STATUSES },
      ]}
      load={getContractPortfolio} getRowId={(c) => c.id}
      emptyTitle="No contracts" emptyDescription="No contract matches these filters. Clear them, or create the first contract to start building rate plans."
      columns={[
        { key: 'code', header: 'Contract', sortKey: 'code', render: (c) => <Link href={`/contracts/${c.id}`} style={{ color: 'var(--c-0d2631)', fontWeight: 600, textDecoration: 'none' }}>{c.code}</Link> },
        { key: 'supplier', header: 'Supplier', render: (c) => c.supplier.displayName },
        { key: 'validity', header: 'Validity', sortKey: 'validFrom', render: (c) => `${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)}` },
        { key: 'currency', header: 'Currency', sortKey: 'settlementCurrency', render: (c) => c.settlementCurrency },
        { key: 'mapping', header: 'Hotel binding', render: (c) => (c.supplierHotelMapping ? c.supplierHotelMapping.status : 'Unbound') },
        { key: 'status', header: 'Status', sortKey: 'status', render: (c) => c.status },
      ]}
    />
  )
}
