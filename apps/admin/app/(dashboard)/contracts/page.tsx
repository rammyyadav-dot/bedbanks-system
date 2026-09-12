'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { DetailDrawer, DrawerField } from '@/components/dialogs/DetailDrawer'
import { StatusBadge } from '@/components/status/StatusBadge'
import { contracts as allContracts } from '@/lib/mock'
import type { Contract } from '@/lib/types/admin'

export default function ContractsPage() {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Contract | null>(null)
  const filtered = allContracts.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.supplier.toLowerCase().includes(search.toLowerCase()))

  const columns: DataTableColumn<Contract>[] = [
    { key: 'supplier', header: 'Supplier', render: (c) => c.supplier },
    { key: 'name', header: 'Contract', render: (c) => c.name },
    { key: 'validity', header: 'Validity', render: (c) => `${c.validFrom} → ${c.validTo}` },
    { key: 'currency', header: 'Currency', render: (c) => c.currency },
    { key: 'markup', header: 'Markup', render: (c) => `${c.markup}%`, align: 'right' },
    { key: 'commission', header: 'Commission', render: (c) => `${c.commission}%`, align: 'right' },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="SUPPLIERS · CONTRACTS" title="Contracts" description="Commercial terms per supplier relationship." />
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search contracts…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(c) => c.id} onRowClick={setSelected} emptyTitle="No contracts found" />
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} title={selected?.name ?? ''} subtitle={selected?.supplier}>
        {selected && (<>
          <DrawerField label="Validity" value={`${selected.validFrom} → ${selected.validTo}`} />
          <DrawerField label="Currency" value={selected.currency} />
          <DrawerField label="Markup" value={`${selected.markup}%`} />
          <DrawerField label="Commission" value={`${selected.commission}%`} />
          <DrawerField label="Status" value={<StatusBadge status={selected.status} />} />
        </>)}
      </DetailDrawer>
    </div>
  )
}
