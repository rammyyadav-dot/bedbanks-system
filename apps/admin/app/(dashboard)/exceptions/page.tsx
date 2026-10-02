'use client'

import { Suspense, useState } from 'react'
import { COMMERCIAL_ISSUE_CATEGORIES, type IssueSeverity } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingState } from '@/components/common/LoadingState'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getCommercialExceptions } from '@/lib/data/hotel-commercial'
import { hotelHref, reasonText, sectionTab, severityTone } from '@/lib/hotel-ui'
import Link from 'next/link'

const PAGE_SIZE = 25

function Exceptions() {
  const [severity, setSeverity] = useState(''); const [category, setCategory] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getCommercialExceptions({ severity: severity || undefined, category: category || undefined, page, pageSize: PAGE_SIZE }), [severity, category, page])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · EXCEPTIONS" title="Commercial exceptions" description="Everything currently stopping or threatening sale, from the same evidence as Hotel readiness. Severity is an operational ranking, not a domain state." />
      <form aria-label="Exception filters" onSubmit={(event) => event.preventDefault()}>
        <TableToolbar>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Severity</span><select value={severity} onChange={(event) => { setSeverity(event.target.value); setPage(1) }}><option value="">All severities</option>{(['CRITICAL', 'HIGH', 'WARNING'] as IssueSeverity[]).map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}><span>Category</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1) }}><option value="">All categories</option>{COMMERCIAL_ISSUE_CATEGORIES.map((c) => <option key={c} value={c}>{c.split('_').join(' ').toLowerCase()}</option>)}</select></label>
        </TableToolbar>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No exceptions', description: 'The scan succeeded and found nothing stopping or threatening sale for the assessed window.' }}>
        {(data) => (
          <div className="workspace-panel" data-testid="exceptions-table">
            <p style={{ padding: '8px 14px', margin: 0, color: '#3f565c' }} data-testid="exception-counts">{data.counts.CRITICAL} critical · {data.counts.HIGH} high · {data.counts.WARNING} warning · window {data.window.from} → {data.window.to}{data.scanCapped ? ' · scan limit reached (first hotels only)' : ''}</p>
            <ScrollRegion label="Commercial exceptions">
              <table style={tableStyle} aria-label="Commercial exceptions">
                <thead><tr>{['Severity', 'Hotel', 'Room / plan', 'Supplier', 'Issue', 'Canonical reason', 'Affected', 'Observed', 'Action'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.items.map((i) => (
                  <tr key={i.id} data-severity={i.severity} data-category={i.category}>
                    <td style={td}><Chip tone={severityTone(i.severity)}>{i.severity}</Chip></td>
                    <td style={td}><Link href={hotelHref(i.hotelId)} style={{ fontWeight: 600 }}>{i.hotelName}</Link></td>
                    <td style={td}>{i.roomName ?? '—'}{i.ratePlanCode ? <div style={{ fontSize: 10 }}><code>{i.ratePlanCode}</code></div> : null}</td>
                    <td style={td}>{i.supplierName ?? '—'}</td>
                    <td style={td}>{i.message}</td>
                    <td style={td}>{i.reason ? <span title={reasonText(i.reason)}><code>{i.reason}</code></span> : <span>{i.category.split('_').join(' ').toLowerCase()}</span>}</td>
                    <td style={td}>{i.from ? (i.from === i.to ? i.from : `${i.from} → ${i.to}`) : '—'}{i.nights ? ` (${i.nights}n)` : ''}</td>
                    <td style={td}>{when(i.observedAt)}</td>
                    <td style={td}><Link href={hotelHref(i.hotelId, sectionTab(i.section))}>Resolve in {i.section}</Link></td>
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

export default function ExceptionsPage() { return <Suspense fallback={<LoadingState rows={6} />}><Exceptions /></Suspense> }
