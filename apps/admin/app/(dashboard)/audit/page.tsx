'use client'

import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { DetailDrawer, DrawerField } from '@/components/dialogs/DetailDrawer'
import { auditEvents } from '@/lib/mock'
import type { AuditEvent } from '@/lib/types/admin'

export default function AuditPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState<AuditEvent | null>(null)

  const filtered = useMemo(() => auditEvents.filter((e) =>
    (status === 'all' || e.status === status) &&
    (e.action.toLowerCase().includes(search.toLowerCase()) || e.actor.toLowerCase().includes(search.toLowerCase())),
  ), [search, status])

  const columns: DataTableColumn<AuditEvent>[] = [
    { key: 'timestamp', header: 'Timestamp', render: (e) => new Date(e.timestamp).toLocaleString() },
    { key: 'actor', header: 'Actor', render: (e) => e.actor },
    { key: 'tenant', header: 'Tenant', render: (e) => e.tenant },
    { key: 'action', header: 'Action', render: (e) => e.action },
    { key: 'resource', header: 'Resource', render: (e) => `${e.resource} · ${e.resourceId}` },
    { key: 'requestId', header: 'Request ID', render: (e) => e.requestId },
    { key: 'status', header: 'Status', render: (e) => <span className={`status-pill ${e.status === 'success' ? 'success' : 'danger'}`}><i className="status-dot" />{e.status}</span> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="BUSINESS · AUDIT" title="Audit Log" description="Immutable, tenant-scoped activity record for compliance and support." />
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by actor or action…" />
        <SelectField label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, { value: 'success', label: 'Success' }, { value: 'failed', label: 'Failed' }]} />
      </TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(e) => e.id} onRowClick={setSelected} emptyTitle="No audit events found" />
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} title={selected?.action ?? ''} subtitle={selected ? new Date(selected.timestamp).toLocaleString() : undefined}>
        {selected && (
          <>
            <DrawerField label="Actor" value={selected.actor} />
            <DrawerField label="Tenant" value={selected.tenant} />
            <DrawerField label="Resource" value={`${selected.resource} · ${selected.resourceId}`} />
            <DrawerField label="Request ID" value={selected.requestId} />
            <DrawerField label="Status" value={selected.status} />
            {Object.entries(selected.metadata).map(([k, v]) => <DrawerField key={k} label={k} value={v} />)}
          </>
        )}
      </DetailDrawer>
    </div>
  )
}
