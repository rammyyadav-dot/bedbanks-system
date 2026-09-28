'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { DetailDrawer, DrawerField } from '@/components/dialogs/DetailDrawer'
import { getContracts, type AdminContract } from '@/lib/data'

export default function ContractsPage() {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AdminContract | null>(null)
  const [allContracts, setContracts] = useState<AdminContract[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    getContracts().then(rows => { if (active) setContracts(rows) }).catch(() => { if (active) { setContracts([]); setError(true) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  const filtered = allContracts.filter((c) => c.code.toLowerCase().includes(search.toLowerCase()) || c.supplier.displayName.toLowerCase().includes(search.toLowerCase()))

  const columns: DataTableColumn<AdminContract>[] = [
    { key: 'supplier', header: 'Supplier', render: (c) => c.supplier.displayName },
    { key: 'name', header: 'Contract', render: (c) => c.code },
    { key: 'validity', header: 'Validity', render: (c) => `${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)}` },
    { key: 'currency', header: 'Currency', render: (c) => c.settlementCurrency },
    { key: 'status', header: 'Status', render: (c) => <span>{c.status}</span> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="SUPPLIERS · CONTRACTS" title="Contracts" description="Commercial terms per supplier relationship." />
      {error && <p role="alert">Contracts are unavailable. Please reload to retry.</p>}
      {loading && <p role="status">Loading contracts…</p>}
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search contracts…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(c) => c.id} onRowClick={setSelected} emptyTitle={loading ? "Loading contracts" : error ? "Contracts unavailable" : "No contracts found"} />
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} title={selected?.code ?? ''} subtitle={selected?.supplier.displayName}>
        {selected && (<>
          <DrawerField label="Validity" value={`${selected.validFrom.slice(0, 10)} → ${selected.validTo.slice(0, 10)}`} />
          <DrawerField label="Currency" value={selected.settlementCurrency} />
          <DrawerField label="Status" value={<span>{selected.status}</span>} />
        </>)}
      </DetailDrawer>
    </div>
  )
}
