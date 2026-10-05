'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money } from '@/components/ops/ops-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { FindingList } from '@/components/rate-certification/FindingList'
import { getRateCertificationPlan } from '@/lib/data/rate-certification'
import { hotelHref, reasonText } from '@/lib/hotel-ui'
import { certificationTone, ROW_CLASS_HELP, rowClassTone } from '@/lib/rate-certification-ui'

export default function RatePlanAuditPage() {
  const { ratePlanId } = useParams<{ ratePlanId: string }>()
  const { state, reload } = useOpsQuery(() => getRateCertificationPlan(ratePlanId, { days: 90 }), [ratePlanId])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="RATES & INVENTORY · CERTIFICATION" title="Rate plan audit" description="Every finding, row class and night for one rate plan, from the same evaluator Agent search uses." actions={<Link href="/rate-certification?tab=plans" className="button">Back to rate plans</Link>} />
      <OpsState state={state} onRetry={reload}>
        {(d) => (
          <div style={{ display: 'grid', gap: 12 }} data-testid="plan-audit" data-status={d.live ? d.status : 'NOT_LIVE'}>
            <section className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 15 }}><code>{d.code}</code></strong>
                {d.live ? <Chip tone={certificationTone(d.status)}>{d.status}</Chip> : <Chip tone="neutral">NOT LIVE</Chip>}
                <Link href={hotelHref(d.hotelId)}>{d.hotelName}</Link>
                <Link href={`/rate-certification?tab=simulator&ratePlanId=${encodeURIComponent(d.ratePlanId)}`}>Simulate a stay</Link>
              </div>
              <div style={{ fontSize: 12, color: '#3f565c' }}>{d.roomName} · {d.boardCode} · occupancy {d.occupancy} · {d.currency} · plan {d.planStatus} · contract {d.contractCode} ({d.contractStatus}, {d.contract.validFrom} → {d.contract.validTo}, settles in {d.contract.settlementCurrency}) · supplier {d.supplierName}</div>
              <div style={{ fontSize: 12 }}>Sellable nights {d.sellableNights} of {d.nights} · amount basis {d.amountBasis}</div>
              {d.suggestedCode && <div style={{ fontSize: 12 }} data-testid="suggested-code">Suggested code <code>{d.suggestedCode}</code> — a suggestion only; an administrator must decide, nothing is renamed automatically.</div>}
            </section>
            <section className="workspace-panel" style={{ padding: 14 }} aria-label="Findings"><h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Findings</h2><FindingList findings={d.findings} emptyText="No findings: every check passed for this plan." /></section>
            <section className="workspace-panel" style={{ padding: 14 }} aria-label="Row classes" data-testid="row-classes">
              <h2 style={{ margin: '0 0 8px', fontSize: 13 }}>Daily rate rows in the window</h2>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4, fontSize: 12 }}>{(Object.entries(d.rowClasses) as Array<[keyof typeof ROW_CLASS_HELP, number]>).map(([name, count]) => <li key={name}><Chip tone={rowClassTone(name)}>{name.split('_').join(' ')}</Chip> <strong>{count}</strong> · {ROW_CLASS_HELP[name]}</li>)}</ul>
              {(d.contract.salesMarkets.length > 0 || d.contract.nationalities.length > 0) && <p style={{ fontSize: 12, margin: '8px 0 0' }}>Sold only to these buyer markets and guest nationalities (enforced by Agent search): markets {d.contract.salesMarkets.join(', ') || '—'} · nationalities {d.contract.nationalities.join(', ') || '—'}.</p>}
            </section>
            <section className="workspace-panel" aria-label="Night by night">
              <ScrollRegion label="Night by night">
                <table style={tableStyle} aria-label="Night by night" data-testid="calendar">
                  <thead><tr>{['Night', 'Stored rate', 'Basis', 'Row class', 'Evaluator', 'Reasons'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                  <tbody>{d.calendar.map((c) => (
                    <tr key={c.date} data-sellable={String(c.sellable)}>
                      <td style={td}>{c.date}</td>
                      <td style={td}><Money minor={c.rateMinor} currency={d.currency} /></td>
                      <td style={td}>{c.basis ?? '—'}</td>
                      <td style={td}>{c.rowClass ? <Chip tone={rowClassTone(c.rowClass)}>{c.rowClass.split('_').join(' ')}</Chip> : '—'}</td>
                      <td style={td}><Chip tone={c.sellable ? 'ok' : 'neutral'}>{c.sellable ? 'SELLABLE' : 'NOT SELLABLE'}</Chip></td>
                      <td style={td}>{c.reasons.length === 0 ? '—' : c.reasons.map((r) => <span key={r} title={reasonText(r)} style={{ marginRight: 6 }}><code>{r}</code></span>)}</td>
                    </tr>))}</tbody>
                </table>
              </ScrollRegion>
            </section>
          </div>
        )}
      </OpsState>
    </div>
  )
}
