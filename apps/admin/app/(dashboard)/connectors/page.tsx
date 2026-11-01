'use client'

import { OpsListPage } from '@/components/ops/OpsListPage'
import { Tag, when } from '@/components/ops/ops-ui'
import { getOpsConnectors } from '@/lib/data/operations'
import type { ConnectorRow } from '@bedbanks/contracts'

export default function ConnectorsPage() {
  return (
    <OpsListPage<ConnectorRow>
      eyebrow="CONNECTORS" title="Connector health" description="Connector definitions and their last recorded executions. Credential rows show presence only; secret values are never returned and nothing here proves a credential is valid."
      load={getOpsConnectors} getRowId={c => c.id}
      emptyTitle="No connectors configured" emptyDescription="The query succeeded and this tenant has no connector definitions. No live supplier is connected."
      columns={[
        { key: 'name', header: 'Connector', render: c => <strong>{c.name}</strong> },
        { key: 'supplier', header: 'Supplier', render: c => c.supplier.displayName },
        { key: 'type', header: 'Type', render: c => c.type },
        { key: 'status', header: 'Status', render: c => <Tag tone={c.status === 'ACTIVE' ? 'ok' : 'neutral'}>{c.status}</Tag> },
        { key: 'health', header: 'Health', render: c => <Tag tone={c.healthState === 'healthy' ? 'ok' : c.healthState === 'unknown' ? 'neutral' : 'bad'}>{c.healthState}</Tag> },
        { key: 'creds', header: 'Credentials', render: c => (c.credentials.length ? c.credentials.map(x => `${x.purpose}: ${x.status}`).join(', ') : 'none') },
        { key: 'last', header: 'Last execution', render: c => (c.lastExecution ? `${c.lastExecution.operation} · ${c.lastExecution.status} · ${when(c.lastExecution.at)}` : 'never') },
        { key: 'fail', header: 'Last failure', render: c => (c.lastFailure ? `${c.lastFailure.errorClassification ?? 'unclassified'} · ${when(c.lastFailure.at)}` : '—') },
      ]}
    />
  )
}
