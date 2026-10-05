'use client'

import Link from 'next/link'
import { useState } from 'react'
import { CERTIFICATION_STATUSES, HOTEL_DISTRIBUTION_STATUSES, RATE_FINDING_CODES, REMEDIATION_PRIORITIES, type HotelDistributionStatus, type RemediationPriority } from '@bedbanks/contracts'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Chip, ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { hotelHref } from '@/lib/hotel-ui'
import { getRateCertificationHotels, getRateCertificationMarkupRules, getRateCertificationPlans, getRateCertificationRemediation } from '@/lib/data/rate-certification'
import { certificationTone, hotelStatusText, hotelStatusTone, percentText, priorityTone, severityTone } from '@/lib/rate-certification-ui'
import { FindingList } from './FindingList'

const PAGE_SIZE = 25
const label = { display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#2c4a55' } as const

export function HotelsTab({ window }: { window: { days: number } }) {
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getRateCertificationHotels({ status: status || undefined, q: q || undefined, days: window.days, page, pageSize: PAGE_SIZE }), [status, q, page, window.days])
  return (
    <div>
      <form aria-label="Hotel certification filters" onSubmit={(event) => event.preventDefault()}>
        <TableToolbar>
          <label style={label}><span>Distribution status</span><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{HOTEL_DISTRIBUTION_STATUSES.map((s) => <option key={s} value={s}>{hotelStatusText(s as HotelDistributionStatus)}</option>)}</select></label>
          <label style={label}><span>Search hotel or city</span><input type="search" value={q} maxLength={64} onChange={(e) => { setQ(e.target.value); setPage(1) }} /></label>
        </TableToolbar>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No hotels', description: 'No hotel matches the filters.' }}>
        {(data) => (
          <div className="workspace-panel" data-testid="hotels-table">
            <ScrollRegion label="Hotel distribution readiness">
              <table style={tableStyle} aria-label="Hotel distribution readiness">
                <thead><tr>{['Hotel', 'City', 'Status', 'Live plans', 'PASS / WARN / FAIL', 'Sellable nights', 'Blockers', 'Warnings'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.items.map((h) => (
                  <tr key={h.hotelId} data-status={h.status}>
                    <td style={td}><Link href={hotelHref(h.hotelId)} style={{ fontWeight: 600 }}>{h.hotelName}</Link></td>
                    <td style={td}>{h.city}</td>
                    <td style={td}><Chip tone={hotelStatusTone(h.status)}>{hotelStatusText(h.status)}</Chip></td>
                    <td style={td}>{h.plans.live} of {h.plans.total}</td>
                    <td style={td}>{h.plans.pass} / {h.plans.warn} / {h.plans.fail}</td>
                    <td style={td}>{h.sellableNights} of {h.totalNights}</td>
                    <td style={td}>{h.blockers.length ? h.blockers.join('; ') : '—'}</td>
                    <td style={td}>{h.warnings.length ? h.warnings.join('; ') : '—'}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

export function PlansTab({ window }: { window: { days: number } }) {
  const [status, setStatus] = useState(''); const [finding, setFinding] = useState(''); const [live, setLive] = useState(''); const [q, setQ] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getRateCertificationPlans({ status: status || undefined, finding: finding || undefined, live: live || undefined, q: q || undefined, days: window.days, page, pageSize: PAGE_SIZE }), [status, finding, live, q, page, window.days])
  return (
    <div>
      <form aria-label="Rate plan filters" onSubmit={(event) => event.preventDefault()}>
        <TableToolbar>
          <label style={label}><span>Certification</span><select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{CERTIFICATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label style={label}><span>Finding</span><select value={finding} onChange={(e) => { setFinding(e.target.value); setPage(1) }}><option value="">Any</option>{RATE_FINDING_CODES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label style={label}><span>Plan state</span><select value={live} onChange={(e) => { setLive(e.target.value); setPage(1) }}><option value="">All</option><option value="true">Live (ACTIVE)</option><option value="false">Not live</option></select></label>
          <label style={label}><span>Search plan, hotel or contract</span><input type="search" value={q} maxLength={64} onChange={(e) => { setQ(e.target.value); setPage(1) }} /></label>
        </TableToolbar>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No rate plans', description: 'No rate plan matches the filters.' }}>
        {(data) => (
          <div className="workspace-panel" data-testid="plans-table">
            <ScrollRegion label="Rate plan certification">
              <table style={tableStyle} aria-label="Rate plan certification">
                <thead><tr>{['Plan', 'Hotel', 'Room · board', 'Contract', 'Occ.', 'Cur.', 'Status', 'Sellable nights', 'Rows valid / quarantined', 'Findings'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.items.map((p) => (
                  <tr key={p.ratePlanId} data-status={p.live ? p.status : 'NOT_LIVE'}>
                    <td style={td}><Link href={`/rate-certification/${p.ratePlanId}`} style={{ fontWeight: 600 }}><code>{p.code}</code></Link></td>
                    <td style={td}><Link href={hotelHref(p.hotelId)}>{p.hotelName}</Link></td>
                    <td style={td}>{p.roomName} · {p.boardCode}</td>
                    <td style={td}>{p.contractCode}</td>
                    <td style={td}>{p.occupancy}</td>
                    <td style={td}>{p.currency}</td>
                    <td style={td}>{p.live ? <Chip tone={certificationTone(p.status)}>{p.status}</Chip> : <Chip tone="neutral" title="Not ACTIVE: reported, not certified">NOT LIVE</Chip>}</td>
                    <td style={td}>{p.sellableNights} of {p.nights}</td>
                    <td style={td}>{p.rowClasses.VALID} / {p.rowClasses.QUARANTINED}</td>
                    <td style={td}>{p.findings.length === 0 ? '—' : p.findings.map((f) => <span key={f.code} style={{ marginRight: 4 }}><Chip tone={severityTone(f.severity)} title={f.message}>{f.code}</Chip></span>)}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

export function RemediationTab({ window }: { window: { days: number } }) {
  const [priority, setPriority] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getRateCertificationRemediation({ priority: priority || undefined, days: window.days, page, pageSize: PAGE_SIZE }), [priority, page, window.days])
  return (
    <div>
      <p style={{ fontSize: 12, color: '#3f565c', margin: '0 0 8px' }}>A to-do list for people. Nothing here can be executed: no rate is changed, merged, deleted or published from this page.</p>
      <form aria-label="Remediation filters" onSubmit={(event) => event.preventDefault()}>
        <TableToolbar>
          <label style={label}><span>Priority</span><select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1) }}><option value="">All</option>{REMEDIATION_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        </TableToolbar>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'Nothing to remediate', description: 'The scan found no live plan with a finding.' }}>
        {(data) => (
          <div className="workspace-panel" data-testid="remediation-table">
            <p style={{ padding: '8px 14px', margin: 0, color: '#3f565c' }} data-testid="remediation-counts">{data.counts.P0} P0 · {data.counts.P1} P1 · {data.counts.P2} P2{data.scanCapped ? ' · scan limit reached (first hotels only)' : ''}</p>
            <ScrollRegion label="Remediation queue">
              <table style={tableStyle} aria-label="Remediation queue">
                <thead><tr>{['Priority', 'Hotel', 'Plan', 'Finding', 'Count', 'Suggested next step'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.items.map((i) => (
                  <tr key={i.id} data-priority={i.priority} data-code={i.code}>
                    <td style={td}><Chip tone={priorityTone(i.priority as RemediationPriority)}>{i.priority}</Chip></td>
                    <td style={td}>{i.hotelId ? <Link href={hotelHref(i.hotelId)}>{i.hotelName}</Link> : i.hotelName}</td>
                    <td style={td}>{i.ratePlanId ? <Link href={`/rate-certification/${i.ratePlanId}`}><code>{i.ratePlanCode}</code></Link> : '—'}</td>
                    <td style={td}><span title={i.message}><code>{i.code}</code></span></td>
                    <td style={td}>{i.count}</td>
                    <td style={td}>{i.suggestedAction}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

export function MarkupTab() {
  const { state, reload } = useOpsQuery(() => getRateCertificationMarkupRules(), [])
  return (
    <OpsState state={state} onRetry={reload} isEmpty={(d) => d.rules.length === 0} empty={{ title: 'No markup rules', description: 'No markup rule exists, so NET rates cannot be sold. SELL rates are unaffected.' }}>
      {(data) => (
        <div className="workspace-panel" data-testid="markup-table">
          <p style={{ padding: '8px 14px', margin: 0, color: '#3f565c' }}>{data.counts.total} rules: {data.counts.active} active · {data.counts.draft} draft · {data.counts.retired} retired. NET plans with an unpriced night: {data.netPlansWithoutMarkup}. Rules are authored under <Link href="/commercial/markups">Markups</Link>; this view only audits them.</p>
          <ScrollRegion label="Markup rules audit">
            <table style={tableStyle} aria-label="Markup rules audit">
              <thead><tr>{['Scope', 'Target', 'Markup', 'Valid', 'Status', 'Findings'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{data.rules.map((r) => (
                <tr key={r.id}>
                  <td style={td}>{r.scope.split('_').join(' ')}</td>
                  <td style={td}>{r.hotelId ? <Link href={hotelHref(r.hotelId)}>Hotel</Link> : r.supplierId ? 'Supplier' : 'All suppliers'}</td>
                  <td style={td} title={`${r.basisPoints} basis points`}>{percentText(r.basisPoints)}</td>
                  <td style={td}>{r.validFrom} → {r.validTo ?? 'open'}</td>
                  <td style={td}>{r.status}</td>
                  <td style={td}><FindingList findings={r.findings} emptyText="—" /></td>
                </tr>))}</tbody>
            </table>
          </ScrollRegion>
        </div>
      )}
    </OpsState>
  )
}
