'use client'

import { useState } from 'react'
import { RECON_EXCEPTION_STATUSES, type ReconFindingType, type ReconSeverity } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getReconExceptions, getReconSummary } from '@/lib/data/finance-reconciliation'
import { STATUS_LABEL, TYPE_LABEL, severityTone, statusTone } from '@/lib/reconciliation-ui'
import { ExceptionPanel } from './ExceptionPanel'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const EXCEPTION_TYPES = (Object.keys(TYPE_LABEL) as ReconFindingType[]).filter((t) => t !== 'MATCHED' && t !== 'CREDIT_MATCHED')
const tile = { border: '1px solid #dbe6e9', borderRadius: 6, background: '#fff', padding: '10px 14px', minWidth: 130 } as const

/** The dispute queue: every exception the matching run found, newest first, with the decision workflow beside it. */
export function DisputeQueue({ statementId, onClearStatement, canResolve, version, onMessage }: { statementId: string | null; onClearStatement: () => void; canResolve: boolean; version: number; onMessage: (m: string) => void }) {
  const [status, setStatus] = useState('OPEN'); const [severity, setSeverity] = useState(''); const [type, setType] = useState(''); const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | null>(null); const [bump, setBump] = useState(0)
  const summary = useOpsQuery(() => getReconSummary(), [version, bump])
  const list = useOpsQuery(() => getReconExceptions({ page, status: status || undefined, severity: severity || undefined, type: type || undefined, statementId: statementId ?? undefined }), [page, status, severity, type, statementId, version, bump])

  return (
    <div>
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }} data-testid="recon-summary">
            {RECON_EXCEPTION_STATUSES.map((k) => <div key={k} style={tile}><div style={{ fontSize: 10, color: '#6d858c' }}>{STATUS_LABEL[k]}</div><strong style={{ fontSize: 20 }}>{s.byStatus[k]}</strong></div>)}
            <div style={{ ...tile, flex: 1 }}>
              <div style={{ fontSize: 10, color: '#6d858c' }}>Unresolved variance, by currency (never added)</div>
              {s.openVarianceByCurrency.length === 0 ? <strong style={{ fontSize: 13 }}>None</strong> : s.openVarianceByCurrency.map((r) => (
                <div key={r.currency} style={{ fontSize: 12 }}><Money minor={r.absoluteVarianceMinor} currency={r.currency} />{r.unknownAmountCount > 0 && <span style={{ color: '#8a5a00' }}> + {r.unknownAmountCount} with no computable variance</span>}</div>
              ))}
            </div>
          </div>
        )}
      </OpsState>

      <div style={{ display: 'flex', gap: 8, alignItems: 'end', margin: '0 0 12px', flexWrap: 'wrap' }}>
        <label style={lab}>Status
          <select className="input-wrap" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} data-testid="recon-status">
            <option value="">All</option>{RECON_EXCEPTION_STATUSES.map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
          </select>
        </label>
        <label style={lab}>Severity
          <select className="input-wrap" value={severity} onChange={(e) => { setSeverity(e.target.value as ReconSeverity | ''); setPage(1) }}>
            <option value="">All</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
          </select>
        </label>
        <label style={lab}>Type
          <select className="input-wrap" value={type} onChange={(e) => { setType(e.target.value); setPage(1) }}>
            <option value="">All</option>{EXCEPTION_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        {statementId && <button type="button" className="admin-btn" onClick={() => { onClearStatement(); setPage(1) }}>Showing one statement · show all</button>}
      </div>

      <OpsState state={list.state} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No exceptions match', description: 'The query succeeded and nothing matches these filters.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="recon-queue">
            <ScrollRegion label="Reconciliation exceptions">
              <table style={tableStyle} aria-label="Reconciliation exceptions">
                <thead><tr>{['Severity', 'Exception', 'Supplier · statement', 'Reference', 'Statement', 'Ledger net', 'Variance', 'Status', ''].map((h, i) => <th key={`${h}-${i}`} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((e) => (
                  <tr key={e.id} data-testid={`recon-row-${e.type.toLowerCase()}`} style={selected === e.id ? { background: '#f3fafb' } : undefined}>
                    <td style={td}><Tag tone={severityTone(e.severity)}>{e.severity.toLowerCase()}</Tag></td>
                    <td style={td}><strong>{TYPE_LABEL[e.type]}</strong><div style={{ fontSize: 10, maxWidth: 240 }}>{e.hint}</div></td>
                    <td style={td}>{e.supplier.displayName}<div style={{ fontSize: 10 }}><code>{e.statementRef}</code>{e.lineNo !== null && ` · line ${e.lineNo}`}</div></td>
                    <td style={td}>{e.reference ? <code>{e.reference}</code> : '—'}{e.booking && <div style={{ fontSize: 10 }}>booking <code>{e.booking.reference}</code></div>}</td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={e.statementMinor} currency={e.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={e.ledgerMinor} currency={e.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}>{e.varianceMinor === null ? <span title="Not computed: currencies differ or an amount is unknown">n/a</span> : <Money minor={e.varianceMinor} currency={e.currency} />}</td>
                    <td style={td}><Tag tone={statusTone(e.status)}>{STATUS_LABEL[e.status]}</Tag><div style={{ fontSize: 10 }}>{when(e.createdAt)}</div></td>
                    <td style={td}><button type="button" className="admin-btn" aria-expanded={selected === e.id} data-testid="recon-review" onClick={() => setSelected(selected === e.id ? null : e.id)}>Review</button></td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
      {selected && <ExceptionPanel id={selected} canResolve={canResolve} onClose={() => setSelected(null)} onChanged={(m) => { onMessage(m); setBump((n) => n + 1) }} />}
    </div>
  )
}
