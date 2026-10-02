'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { SectionState } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { OPS_FAILURE_COPY } from '@/lib/ops-state'
import { getReliabilitySummary } from '@/lib/data/operations'

function Section<T>({ title, section, children }: { title: string; section: SectionState<T>; children: (data: T) => ReactNode }) {
  return (
    <section className="workspace-panel" style={{ padding: '12px 18px', marginBottom: 12 }} aria-labelledby={`rel-${title}`}>
      <h2 id={`rel-${title}`}>{title}</h2>
      {section.state === 'unavailable'
        ? <div role="status" data-state="denied"><strong>{OPS_FAILURE_COPY.denied.title}</strong><p>{OPS_FAILURE_COPY.denied.body}</p></div>
        : children(section.data)}
    </section>
  )
}
const Stat = ({ label, value, href }: { label: string; value: number | string; href?: string }) => (
  <div style={{ display: 'inline-block', minWidth: 150, margin: '4px 16px 4px 0' }}>
    <div style={{ font: '700 24px system-ui' }}>{href ? <Link href={href}>{value}</Link> : value}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{label}</div>
  </div>
)

/** System health from existing operational records: connectors, connector executions, uncertain supplier calls and stalled holds. */
export default function ReliabilityPage() {
  const { state, reload } = useOpsQuery(() => getReliabilitySummary(), [])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="SYSTEM & RELIABILITY" title="System health" description="Connector health, execution failures, supplier calls with an unknown outcome and stalled holds. Counts only; nothing is estimated in the browser." />
      <OpsState state={state} onRetry={reload}>
        {(r) => (
          <>
            <p style={{ color: '#3f565c' }}>Generated {when(r.generatedAt)} · executions window {r.window.from} → {r.window.to} ({r.window.days} days)</p>
            <Section title="Connectors" section={r.connectors}>{(c) => <><Stat label="Connectors" value={c.total} href="/connectors" /><Stat label="Enabled" value={c.enabled} href="/connectors" /><Stat label="Unhealthy" value={c.unhealthy} href="/connectors" /><Stat label="Health unknown" value={c.unknown} href="/connectors" /></>}</Section>
            <Section title="Connector executions" section={r.executions}>{(e) => (
              <>
                <Stat label="Executions" value={e.total} /><Stat label="Succeeded" value={e.succeeded} /><Stat label="Failed" value={e.failed} /><Stat label="Retrying" value={e.retrying} />
                {e.byClassification.length > 0 && <p style={{ fontSize: 11, color: '#3f565c' }}>Failures by classification: {e.byClassification.map((c) => `${c.classification} ${c.count}`).join(' · ')}</p>}
              </>
            )}</Section>
            <Section title="Supplier outcomes" section={r.supplierOutcomes}>{(s) => (
              <>
                <Stat label="Unknown or sending" value={s.uncertain} href="/reconciliation" />
                <p style={{ fontSize: 11, color: '#3f565c' }}>{s.uncertain > 0 ? `Oldest since ${when(s.oldestUncertainAt)}. These may have reached the supplier: resolve through reconciliation, never retry blindly.` : 'No supplier call is waiting on an unobserved outcome.'}</p>
              </>
            )}</Section>
            <Section title="Holds" section={r.holds}>{(h) => <><Stat label={`Processing over ${h.staleMinutes} min`} value={h.stalledProcessing} href="/reconciliation" /></>}</Section>
            <details style={{ fontSize: 11, color: '#3f565c' }}><summary>How these numbers are defined</summary><ul>{Object.entries(r.definitions).map(([k, v]) => <li key={k}><strong>{k}</strong>: {v}</li>)}</ul></details>
          </>
        )}
      </OpsState>
    </div>
  )
}
