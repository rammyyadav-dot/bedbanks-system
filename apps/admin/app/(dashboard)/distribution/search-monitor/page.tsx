'use client'

import { useState } from 'react'
import { SEARCH_MONITOR_STATUSES, type SearchMonitorStatus } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getSearchMonitor } from '@/lib/data/hotel-commercial'

const LABEL: Record<SearchMonitorStatus, string> = { available: 'Available', partial: 'Partial (a source failed)', no_availability: 'No availability', provider_unavailable: 'Source unavailable', mapping_unavailable: 'Mapping unavailable' }
const TONE: Record<SearchMonitorStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = { available: 'ok', partial: 'warn', no_availability: 'neutral', provider_unavailable: 'bad', mapping_unavailable: 'bad' }

/** Agent Search Monitor (ADR 0053). Outcomes of executed searches, read from the audit record. It reports what happened, not why a rule removed an offer. */
export default function SearchMonitorPage() {
  const [days, setDays] = useState('7')
  const q = useOpsQuery(() => getSearchMonitor({ days }), [days])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION · SEARCH MONITOR" title="Agent Search Monitor" description="Outcomes of Agent searches that were executed. A source failure is shown as a failure, never as an empty market." />
      <label style={{ display: 'inline-grid', gap: 2, fontSize: 11, marginBottom: 12, color: 'var(--c-17333e)' }}><span style={{ color: 'var(--c-3f565c)' }}>Period</span>
        <select style={{ color: 'var(--c-17333e)' }} value={days} onChange={(e) => setDays(e.target.value)}>{[['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <OpsState state={q.state} onRetry={q.reload} isEmpty={(d) => d.total === 0} empty={{ title: 'No searches recorded in this period', description: 'The query succeeded and no executed search was recorded. Cached answers are not recorded.' }}>
        {(d) => (
          <div style={{ display: 'grid', gap: 12 }} data-testid="search-monitor">
            {d.truncated && <p role="status" style={{ color: 'var(--c-8a5a00)', fontSize: 12 }}>More events exist than the read limit; the figures below cover only the most recent ones.</p>}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              <li className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 22px system-ui' }}>{d.total}</div><div style={{ fontSize: 11 }}>Searches</div></li>
              {SEARCH_MONITOR_STATUSES.map((s) => <li key={s} className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 22px system-ui' }}>{d.byStatus[s]}</div><div style={{ fontSize: 11 }}><Tag tone={TONE[s]}>{LABEL[s]}</Tag></div></li>)}
            </ul>
            <div className="workspace-panel"><h2 style={{ fontSize: 14, margin: 12 }}>Destinations with problem searches</h2>
              {d.problemDestinations.length === 0 ? <p style={{ margin: 12, fontSize: 12 }}>None in this period.</p> : (
                <ScrollRegion label="Problem destinations"><table style={tableStyle}><thead><tr>{['Destination', 'Problem searches', ...SEARCH_MONITOR_STATUSES.filter((s) => s !== 'available').map((s) => LABEL[s])].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                  <tbody>{d.problemDestinations.map((p) => <tr key={p.destination}><td style={td}>{p.destination}</td><td style={td}>{p.total}</td>{SEARCH_MONITOR_STATUSES.filter((s) => s !== 'available').map((s) => <td key={s} style={td}>{p.counts[s]}</td>)}</tr>)}</tbody></table></ScrollRegion>)}
            </div>
            <div className="workspace-panel"><h2 style={{ fontSize: 14, margin: 12 }}>Recent problem searches</h2>
              <ScrollRegion label="Recent problem searches"><table style={tableStyle}><thead><tr>{['When', 'Destination', 'Outcome', 'Request'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.recent.map((r, i) => <tr key={`${r.requestId ?? 'x'}-${i}`}><td style={td}>{when(r.at)}</td><td style={td}>{r.destination}</td><td style={td}><Tag tone={TONE[r.status]}>{LABEL[r.status]}</Tag></td><td style={td}><code style={{ fontSize: 10 }}>{r.requestId ?? '—'}</code></td></tr>)}</tbody></table></ScrollRegion>
            </div>
            <details style={{ fontSize: 11, color: 'var(--c-3f565c)' }}><summary>What these numbers mean</summary><ul>{Object.entries(d.definitions).map(([k, v]) => <li key={k}><strong>{k}</strong>: {v}</li>)}</ul></details>
          </div>
        )}
      </OpsState>
    </div>
  )
}
