'use client'

import { Suspense } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingState } from '@/components/common/LoadingState'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Chip } from '@/components/hotels/ui'
import { HotelsTab, MarkupTab, PlansTab, RemediationTab } from '@/components/rate-certification/Tabs'
import { ReportTab } from '@/components/rate-certification/ReportTab'
import { Simulator } from '@/components/rate-certification/Simulator'
import { getRateCertificationSummary } from '@/lib/data/rate-certification'
import { ROW_CLASS_HELP, WINDOW_OPTIONS } from '@/lib/rate-certification-ui'

const TABS = [['hotels', 'Hotels'], ['plans', 'Rate plans'], ['remediation', 'Remediation'], ['markup', 'Markup rules'], ['simulator', 'Price simulator'], ['report', 'Report']] as const
type TabId = (typeof TABS)[number][0]
const card = { padding: '10px 14px', minWidth: 150 } as const

function RateCertification() {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams()
  const tab = (TABS.find(([id]) => id === params.get('tab'))?.[0] ?? 'hotels') as TabId
  const requested = Number(params.get('days'))
  const days = (WINDOW_OPTIONS as readonly number[]).includes(requested) ? requested : 90
  const go = (next: { tab?: string; days?: number; ratePlanId?: string }) => {
    const query = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(next)) { if (value === undefined || value === '') query.delete(key); else query.set(key, String(value)) }
    router.replace(`${pathname}?${query.toString()}`, { scroll: false })
  }
  const summary = useOpsQuery(() => getRateCertificationSummary({ days }), [days])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="RATES & INVENTORY · CERTIFICATION" title="Rate certification" description="A read-only audit of rate plans and daily rates against the evaluator Agent search prices with. It reports; it never repairs, merges, deletes or publishes anything." />
      <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, marginBottom: 12, color: '#2c4a55' }}><span>Audit window</span>
        <select value={days} onChange={(event) => go({ days: Number(event.target.value) })} aria-label="Audit window">{WINDOW_OPTIONS.map((d) => <option key={d} value={d}>Next {d} nights</option>)}</select></label>
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <section aria-label="Certification summary" data-testid="summary" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="workspace-panel" style={card}><div style={{ fontSize: 11 }}>Rate plans (live)</div><strong data-testid="plans-counts">{s.plans.PASS} PASS · {s.plans.WARN} WARN · {s.plans.FAIL} FAIL</strong><div style={{ fontSize: 11, color: '#3f565c' }}>{s.totals.livePlans} live of {s.totals.plans}</div></div>
              <div className="workspace-panel" style={card}><div style={{ fontSize: 11 }}>Hotels</div><strong data-testid="hotels-counts">{s.hotels.CERTIFIED} certified · {s.hotels.READY_WITH_WARNINGS} with warnings · {s.hotels.NOT_READY} not ready</strong><div style={{ fontSize: 11, color: '#3f565c' }}>{s.totals.hotels} assessed</div></div>
              <div className="workspace-panel" style={card}><div style={{ fontSize: 11 }}>Remediation</div><strong data-testid="remediation-summary">{s.remediation.P0} P0 · {s.remediation.P1} P1 · {s.remediation.P2} P2</strong></div>
              <div className="workspace-panel" style={card}><div style={{ fontSize: 11 }}>Markup rules</div><strong>{s.markup.activeRules} active</strong><div style={{ fontSize: 11, color: '#3f565c' }}>{s.markup.findings} finding{s.markup.findings === 1 ? '' : 's'}</div></div>
            </div>
            <p style={{ fontSize: 11, color: '#3f565c', margin: '8px 0 0' }} data-testid="row-classes">Daily rate rows: {Object.entries(s.rowClasses).map(([name, count]) => <span key={name} title={ROW_CLASS_HELP[name as keyof typeof ROW_CLASS_HELP]} style={{ marginRight: 10 }}>{name.split('_').join(' ')} <strong>{count}</strong></span>)}</p>
            <p style={{ fontSize: 11, color: '#3f565c', margin: '4px 0 0' }}>Observed {new Date(s.generatedAt).toLocaleString()} for {s.window.from} → {s.window.to}. A certification is an observation, not a switch: it does not change what Agents can search or book.{s.scanCapped ? ' Scan limit reached: only the first hotels by name are assessed.' : ''} <Chip tone="neutral">READ ONLY</Chip></p>
          </section>
        )}
      </OpsState>
      <div role="tablist" aria-label="Certification views" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
        {TABS.map(([id, text]) => <button key={id} role="tab" type="button" aria-selected={tab === id} className={tab === id ? 'admin-btn primary' : 'admin-btn'} onClick={() => go({ tab: id })}>{text}</button>)}
      </div>
      {tab === 'hotels' && <HotelsTab window={{ days }} />}
      {tab === 'plans' && <PlansTab window={{ days }} />}
      {tab === 'remediation' && <RemediationTab window={{ days }} />}
      {tab === 'markup' && <MarkupTab />}
      {tab === 'simulator' && <Simulator initialRatePlanId={params.get('ratePlanId') ?? ''} />}
      {tab === 'report' && <ReportTab window={{ days }} />}
    </div>
  )
}

export default function RateCertificationPage() { return <Suspense fallback={<LoadingState rows={6} />}><RateCertification /></Suspense> }
