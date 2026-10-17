'use client'

import { useState } from 'react'
import { COMPLIANCE_CATEGORY_VALUES, type ComplianceCategoryValue, type ComplianceExportState, type ComplianceRecordView } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getComplianceRecords, getComplianceSummary } from '@/lib/data/operations'

const CATEGORY_LABELS: Record<ComplianceCategoryValue, string> = {
  RBAC_CHANGE: 'Role & membership changes', PRIVILEGED_ACCESS: 'Privileged access', ACCESS_DENIAL: 'Access denials', TENANT_GOVERNANCE: 'Tenant governance',
  DATA_EXPORT: 'Data exports', FINANCIAL_CONTROL: 'Financial controls', BOOKING_JURISDICTION: 'Booking jurisdiction',
}
const EXPORT_LABELS: Record<ComplianceExportState, string> = { PENDING: 'Not yet exported', SEALED: 'Sealed, not stored', STORED: 'Stored (WORM)' }
const exportTone = (s: ComplianceExportState) => (s === 'STORED' ? 'ok' : s === 'SEALED' ? 'warn' : 'neutral') as 'ok' | 'warn' | 'neutral'
const PAGE_SIZE = 25

function Jurisdiction({ r }: { r: ComplianceRecordView }) {
  if (r.category !== 'BOOKING_JURISDICTION') return <>—</>
  const route = `${r.originCountry ?? '??'} → ${r.destinationCountry ?? '??'}`
  return <span>{route} {r.crossBorder === null ? <Tag>UNKNOWN</Tag> : r.crossBorder ? <Tag tone="warn">CROSS-BORDER</Tag> : <Tag tone="ok">DOMESTIC</Tag>}</span>
}

/**
 * Compliance evidence (ADR 0067): what the database captured from the audit trail, and how far each record is on its way to write-once storage.
 * Read-only. The audit payload is not shown here, only its SHA-256 (the Audit explorer shows the payload); the hash matches the archived copy.
 */
export default function CompliancePage() {
  const [draft, setDraft] = useState({ category: '', exportState: '', crossBorder: '', from: '', to: '' })
  const [applied, setApplied] = useState(draft)
  const [page, setPage] = useState(1)
  const summary = useOpsQuery(() => getComplianceSummary(), [])
  const records = useOpsQuery(() => getComplianceRecords({ ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v !== '')), page, pageSize: PAGE_SIZE }), [applied, page])
  const select = (key: keyof typeof draft, label: string, options: Array<[string, string]>) => (
    <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#3f565c' }}><span>{label}</span>
      <select style={{ color: '#17333e' }} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}><option value="">All</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>
  )
  return (
    <div className="admin-page">
      <PageHeader eyebrow="RISK & COMPLIANCE" title="Compliance evidence" description="Role changes, privileged access, denials, governance decisions, data exports, financial controls and booking jurisdiction, captured by the database in the same transaction as the audit event and exported in hash-chained batches to write-once storage. Read-only." />
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <section aria-label="Compliance summary" data-testid="compliance-summary" style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#3f565c', marginBottom: 6 }}>Captured {s.window.from} to {s.window.to} ({s.window.days} days)</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
              {[...s.byCategory.map((c) => [CATEGORY_LABELS[c.category], c.count] as const), ['Cross-border bookings', s.bookings.crossBorder] as const, ['Bookings, countries unknown', s.bookings.unknown] as const].map(([label, value]) => (
                <li key={label} className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 22px system-ui', color: '#17333e' }}>{value}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{label}</div></li>
              ))}
            </ul>
            <div className="workspace-panel" data-testid="compliance-export" style={{ padding: '10px 14px', marginTop: 8, fontSize: 12, color: '#17333e' }}>
              {s.export.state === 'unavailable' ? <span>Export status is not readable by the API database role. <Tag tone="bad">UNAVAILABLE</Tag></span> : (
                <span>
                  <strong>Export chain:</strong> {s.export.data.stored} of {s.export.data.batches} batch(es) stored{s.export.data.sealedNotStored ? <> · <Tag tone="warn">{s.export.data.sealedNotStored} SEALED, NOT STORED</Tag></> : null}
                  {' · '}last stored {when(s.export.data.lastStoredAt)}
                  {' · '}{s.export.data.pendingRecords} record(s) not yet exported{s.export.data.oldestPendingAt ? ` (oldest ${when(s.export.data.oldestPendingAt)})` : ''}
                  {s.export.data.headSha256 ? <div style={{ marginTop: 4 }}>Head #{s.export.data.headSequence}: <code style={{ wordBreak: 'break-all' }}>{s.export.data.headSha256}</code></div> : <div style={{ marginTop: 4 }}>No batch has been sealed for this tenant yet.</div>}
                </span>
              )}
            </div>
          </section>
        )}
      </OpsState>
      <form aria-label="Compliance filters" onSubmit={(e) => { e.preventDefault(); setApplied(draft); setPage(1) }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
        {select('category', 'Category', COMPLIANCE_CATEGORY_VALUES.map((c) => [c, CATEGORY_LABELS[c]]))}
        {select('exportState', 'Export', (Object.keys(EXPORT_LABELS) as ComplianceExportState[]).map((s) => [s, EXPORT_LABELS[s]]))}
        {select('crossBorder', 'Jurisdiction', [['true', 'Cross-border'], ['false', 'Domestic']])}
        {(['from', 'to'] as const).map((key) => (
          <label key={key} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#3f565c' }}><span>{key === 'from' ? 'From' : 'To'}</span>
            <input type="date" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </label>
        ))}
        <button type="submit">Apply</button>
      </form>
      <OpsState state={records.state} onRetry={records.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No compliance records', description: 'The query succeeded and no captured record matches these filters.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="compliance-table">
            <ScrollRegion label="Compliance records">
              <table style={tableStyle} aria-label="Compliance records">
                <thead><tr>{['When', 'Category', 'Action', 'Entity', 'Actor', 'Jurisdiction', 'Export', 'Payload SHA-256'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{when(r.occurredAt)}</td>
                    <td style={td}>{CATEGORY_LABELS[r.category]}</td>
                    <td style={td}><code>{r.action}</code></td>
                    <td style={td}>{r.entityType} · {r.entityId}</td>
                    <td style={td}><Tag>{r.actorType}</Tag>{r.userId ? <div style={{ fontSize: 10 }}>{r.userId}</div> : null}</td>
                    <td style={td}><Jurisdiction r={r} /></td>
                    <td style={td}><Tag tone={exportTone(r.exportState)}>{EXPORT_LABELS[r.exportState]}</Tag>{r.batchSequence ? <div style={{ fontSize: 10 }}>batch #{r.batchSequence}{r.storedAt ? ` · ${when(r.storedAt)}` : ''}</div> : null}</td>
                    <td style={td}><code title={r.payloadSha256} style={{ fontSize: 10 }}>{r.payloadSha256.slice(0, 16)}…</code></td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}
