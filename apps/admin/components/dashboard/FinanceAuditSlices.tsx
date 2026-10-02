'use client'

import Link from 'next/link'
import { departments, type DepartmentId, type SectionState } from '@bedbanks/contracts'
import { getAuditSummary, getFinanceSummary } from '@/lib/data/operations'
import { formatMinorUnits } from '@/lib/minor-units'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { OPS_FAILURE_COPY } from '@/lib/ops-state'

function Card({ id, children, window }: { id: DepartmentId; children: React.ReactNode; window?: string }) {
  const dept = departments.find((d) => d.id === id)!
  const home = dept.modules.find((m) => m.readiness === 'live')?.href ?? '/dashboard'
  return (
    <section className="dashboard-panel" aria-labelledby={`dept-${id}`} data-testid={`dept-${id}`}>
      <div className="dashboard-panel-header"><div><h2 id={`dept-${id}`}>{dept.label}</h2><p>{window ? `${dept.summary} · ${window}` : dept.summary}</p></div><Link href={home}>Open</Link></div>
      {children}
    </section>
  )
}
function Denied() { return <div role="status" data-state="denied"><strong>{OPS_FAILURE_COPY.denied.title}</strong><p>{OPS_FAILURE_COPY.denied.body}</p></div> }
function Section<T>({ section, children }: { section: SectionState<T>; children: (data: T) => React.ReactNode }) { return section.state === 'unavailable' ? <Denied /> : <>{children(section.data)}</> }
const Stat = ({ label, value, href }: { label: string; value: number | string; href?: string }) => {
  const body = <><strong style={{ font: '700 18px system-ui', color: '#17333e' }}>{value}</strong><div style={{ fontSize: 12, color: '#3f565c' }}>{label}</div></>
  return <li>{href ? <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link> : body}</li>
}
const grid = { listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 } as const

/**
 * Finance and Audit slices from the API's own summary endpoints. Currencies are shown separately (the API never adds
 * them), amounts are formatted from integer minor units only, and a section the database role cannot read shows as denied.
 */
export function FinanceAuditSlices() {
  const fin = useOpsQuery(() => getFinanceSummary(), [])
  const aud = useOpsQuery(() => getAuditSummary(), [])
  return (
    <>
      <Card id="finance" window={fin.state.status === 'ready' ? `last ${fin.state.data.window.days} days` : undefined}>
        <OpsState state={fin.state} onRetry={fin.reload}>
          {(f) => (
            <>
              <Section section={f.wallets}>{(w) => (
                <ul style={grid}>
                  <Stat label="Wallets" value={w.total} href="/finance/wallets" />
                  {w.currencies.map((c) => <Stat key={c.currency} label={`${c.currency} available credit`} value={formatMinorUnits(c.availableCreditMinor, c.currency)} href="/finance/wallets" />)}
                  {w.currencies.some((c) => c.overdrawnWallets > 0) && <Stat label="Overdrawn wallets" value={w.currencies.reduce((n, c) => n + c.overdrawnWallets, 0)} href="/finance/wallets" />}
                </ul>
              )}</Section>
              <Section section={f.ledger}>{(l) => (
                <ul style={grid}>
                  <Stat label="Ledger entries" value={l.entries} href="/finance/ledger" />
                  {l.byCurrency.map((c) => <Stat key={c.currency} label={`${c.currency} net movement`} value={formatMinorUnits(c.netMinor, c.currency)} href="/finance/ledger" />)}
                </ul>
              )}</Section>
            </>
          )}
        </OpsState>
      </Card>
      <Card id="audit" window={aud.state.status === 'ready' ? `last ${aud.state.data.window.days} days` : undefined}>
        <OpsState state={aud.state} onRetry={aud.reload}>
          {(a) => (
            <Section section={a.events}>{(e) => (
              <>
                <ul style={grid}>
                  <Stat label="Audit events" value={e.total} href="/audit" />
                  <Stat label="Denied actions" value={e.attention.denied} href="/audit" />
                  <Stat label="Unknown supplier outcomes" value={e.attention.unknownSupplierOutcomes} href="/reconciliation" />
                  <Stat label="Self-approval attempts" value={e.attention.selfApprovalAttempts} href="/audit" />
                </ul>
                {e.byDomain.length > 0 && <p style={{ fontSize: 11, color: '#3f565c', margin: 0 }}>{e.byDomain.slice(0, 5).map((d) => `${d.domain} ${d.events}`).join(' · ')}</p>}
              </>
            )}</Section>
          )}
        </OpsState>
      </Card>
    </>
  )
}
