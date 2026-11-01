'use client'

import { OpsListPage } from '@/components/ops/OpsListPage'
import { Tag, when } from '@/components/ops/ops-ui'
import { getOpsAudit } from '@/lib/data/operations'
import type { AuditEventView } from '@bedbanks/contracts'

export default function AuditPage() {
  return (
    <OpsListPage<AuditEventView>
      eyebrow="AUDIT" title="Audit explorer" description="Immutable, sanitised audit events for the active tenant. Credentials, tokens and guest contact details are redacted at write time."
      filters={[
        { key: 'requestId', label: 'Request id', type: 'text' }, { key: 'correlationId', label: 'Correlation id', type: 'text' },
        { key: 'action', label: 'Action prefix', type: 'text', placeholder: 'e.g. booking.' }, { key: 'entityType', label: 'Entity type', type: 'text' },
        { key: 'entityId', label: 'Entity id', type: 'text' }, { key: 'userId', label: 'User id', type: 'text' },
        { key: 'from', label: 'From', type: 'date' }, { key: 'to', label: 'To', type: 'date' },
      ]}
      load={getOpsAudit} getRowId={a => a.id}
      emptyTitle="No audit events" emptyDescription="The query succeeded and no audit event matches these filters."
      columns={[
        { key: 'at', header: 'When', render: a => when(a.at) },
        { key: 'action', header: 'Action', render: a => <code>{a.action}</code> },
        { key: 'entity', header: 'Entity', render: a => `${a.entityType} · ${a.entityId}` },
        { key: 'actor', header: 'Actor', render: a => <Tag>{a.actorType}</Tag> },
        { key: 'request', header: 'Request id', render: a => (a.requestId ? <code>{a.requestId}</code> : '—') },
        { key: 'payload', header: 'Detail', render: a => <details><summary>payload</summary><pre style={{ maxWidth: 420, overflow: 'auto', margin: 0 }}>{JSON.stringify(a.payload, null, 2)}</pre></details> },
      ]}
    />
  )
}
