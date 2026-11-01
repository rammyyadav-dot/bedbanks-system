'use client'

import { useState } from 'react'
import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { DetailDrawer } from '@/components/dialogs/DetailDrawer'
import { ContractMarketValidity } from '@/components/commercial/ContractMarketValidity'
import { useCan } from '@/lib/auth/capabilities'
import { getContractPortfolio, type AdminContract } from '@/lib/data'

const STATUSES = ['DRAFT', 'REVIEW', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map((value) => ({ value, label: value }))

/** Search, status filter, sort and pagination all run on the API, so the page never holds the whole contract book in memory. */
export default function ContractsPage() {
  const can = useCan()
  const canManage = can('supply.contracts.manage')
  const [selectedContract, setSelectedContract] = useState<AdminContract | null>(null)
  return (
    <>
      <OpsListPage<AdminContract>
        eyebrow="COMMERCIAL · CONTRACTS" title="Contracts" description="Authoritative commercial terms per supplier relationship."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/market-groups" className="admin-btn">Source market groups</Link>
            {canManage ? <Link href="/contracts/new" className="admin-btn admin-btn-primary">New contract</Link> : null}
          </div>
        }
        filters={[
          { key: 'search', label: 'Search', type: 'text', placeholder: 'Code or supplier…' },
          { key: 'status', label: 'Status', type: 'select', options: STATUSES },
        ]}
        load={getContractPortfolio} getRowId={(c) => c.id}
        emptyTitle="No contracts" emptyDescription="No contract matches these filters. Clear them, or create the first contract to start building rate plans."
        columns={[
          { key: 'code', header: 'Contract', sortKey: 'code', render: (c) => <Link href={`/contracts/${c.id}`} style={{ color: 'var(--c-111111)', fontWeight: 600, textDecoration: 'none' }}>{c.code}</Link> },
          { key: 'supplier', header: 'Supplier', render: (c) => c.supplier.displayName },
          { key: 'validity', header: 'Validity', sortKey: 'validFrom', render: (c) => `${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)}` },
          { key: 'currency', header: 'Currency', sortKey: 'settlementCurrency', render: (c) => c.settlementCurrency },
          { key: 'mapping', header: 'Hotel binding', render: (c) => (c.supplierHotelMapping ? c.supplierHotelMapping.status : 'Unbound') },
          { key: 'status', header: 'Status', sortKey: 'status', render: (c) => c.status },
          {
            key: 'marketValidity',
            header: 'Source markets',
            render: (c) => (
              <button
                type="button"
                className="admin-btn"
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => setSelectedContract(c)}
                data-testid={`open-market-validity-drawer-${c.code}`}
              >
                Market validity &amp; simulator
              </button>
            ),
          },
        ]}
      />
      <DetailDrawer
        open={selectedContract !== null}
        onClose={() => setSelectedContract(null)}
        title={selectedContract ? `Contract ${selectedContract.code} · Source Market Profiling` : 'Source Market Profiling'}
        subtitle={selectedContract ? `${selectedContract.supplier.displayName} · ${selectedContract.validFrom.slice(0, 10)} → ${selectedContract.validTo.slice(0, 10)}` : undefined}
      >
        {selectedContract ? (
          <ContractMarketValidity
            contractId={selectedContract.id}
            contractCode={selectedContract.code}
            contractStatus={selectedContract.status}
            canManage={canManage}
          />
        ) : null}
      </DetailDrawer>
    </>
  )
}
