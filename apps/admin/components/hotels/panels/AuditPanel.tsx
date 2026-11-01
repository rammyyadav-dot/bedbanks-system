'use client'

import { useState } from 'react'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { getHotelAudit } from '@/lib/data/hotel-commercial'
import { ScrollRegion, td, th, tableStyle } from '../ui'

/** Audit events for the hotel and its rooms, mappings, contracts and rate plans. Payloads are sanitised at write time. */
export function AuditPanel({ hotelId }: { hotelId: string }) {
  const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getHotelAudit(hotelId, { page, pageSize: 25 }), [hotelId, page])
  return (
    <div className="workspace-panel" style={{ padding: 18 }}>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No audit events', description: 'The query succeeded and nothing has been audited for this hotel yet.' }}>
        {(data) => (
          <>
            <ScrollRegion label="Hotel audit events"><table style={tableStyle} aria-label="Hotel audit events">
              <thead><tr>{['When', 'Actor', 'Action', 'Entity', 'Request id', 'Reason', 'Correlation id', 'Detail'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{data.items.map((e) => (
                <tr key={e.id}><td style={td}>{when(e.at)}</td><td style={td}><Tag>{e.actorType}</Tag>{e.userId ? <div style={{ fontSize: 10 }}>{e.userId}</div> : null}</td><td style={td}><code>{e.action}</code></td><td style={td}>{e.entityType} · {e.entityId}</td>
                  <td style={td}>{e.requestId ? <code>{e.requestId}</code> : '—'}</td><td style={td}>{typeof e.payload?.reason === 'string' ? e.payload.reason : '—'}</td><td style={td}>{e.correlationId ? <code>{e.correlationId}</code> : '—'}</td>
                  <td style={td}><details><summary>payload</summary><pre style={{ maxWidth: 360, overflow: 'auto', margin: 0 }}>{JSON.stringify(e.payload, null, 2)}</pre></details></td></tr>))}</tbody></table></ScrollRegion>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </OpsState>
    </div>
  )
}
