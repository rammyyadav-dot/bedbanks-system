'use client'

import { useState } from 'react'
import Link from 'next/link'
import { HOTEL_DEAL_KINDS, HOTEL_DEAL_KIND_INFO, HOTEL_DEAL_STATUSES, type HotelDealStatus } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { useCan } from '@/lib/auth/capabilities'
import { describeApiError } from '@/lib/api/describe-error'
import { getDealSummary, getDeals, reconcileDeals } from '@/lib/data/hotel-deals'
import { DealStatusTag, STATUS_LABEL } from './DealStatusTag'

const PAGE_SIZE = 25
const TILES: ReadonlyArray<{ status: HotelDealStatus | ''; label: string }> = [
  { status: '', label: 'Total' }, { status: 'DRAFT', label: 'Draft' }, { status: 'PENDING_APPROVAL', label: 'Pending approval' }, { status: 'APPROVED', label: 'Approved, not live' }, { status: 'SCHEDULED', label: 'Scheduled' },
  { status: 'ACTIVE', label: 'Active' }, { status: 'PAUSED', label: 'Paused' }, { status: 'EXPIRED', label: 'Expired' }, { status: 'REJECTED', label: 'Rejected' }, { status: 'SUSPENDED', label: 'Suspended' }, { status: 'ARCHIVED', label: 'Archived' },
]

/**
 * Deals of the tenant, or of one hotel. Every count and every badge is what applies today in the hotel's calendar, computed by the API; this view
 * shows it and never derives a status itself.
 */
export function DealsOverview({ hotelId, newHref }: { hotelId?: string; newHref: string }) {
  const canManage = useCan()('supply.rates.manage')
  const [status, setStatus] = useState<HotelDealStatus | ''>(''); const [kind, setKind] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null); const [busy, setBusy] = useState(false)
  const summary = useOpsQuery(() => getDealSummary({ hotelId }), [hotelId])
  const list = useOpsQuery(() => getDeals({ hotelId, status: status || undefined, kind: kind || undefined, q: search.trim() || undefined, page, pageSize: PAGE_SIZE }), [hotelId, status, kind, search, page])

  async function sync() {
    if (busy) return
    setBusy(true); setNotice(null)
    try {
      const result = await reconcileDeals()
      setNotice({ tone: 'ok', text: result.activated + result.expired === 0 ? 'Every stored status already matches the hotel calendar.' : `Updated ${result.activated} deal(s) that have started and ${result.expired} that have ended.` })
      summary.reload(); list.reload()
    } catch (error) { setNotice({ tone: 'bad', text: describeApiError(error, 'update the statuses') }) } finally { setBusy(false) }
  }

  return (
    <section aria-label="Deals and promotions" data-testid="deals-overview">
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(counts) => (
          <ul aria-label="Deals by status" style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
            {TILES.map((tile) => {
              const value = tile.status === '' ? counts.total : counts.byStatus[tile.status]
              const active = status === tile.status
              return (
                <li key={tile.label}>
                  <button type="button" className="admin-btn" aria-pressed={active} onClick={() => { setStatus(tile.status); setPage(1) }} style={{ width: '100%', flexDirection: 'column', alignItems: 'flex-start', background: active ? 'var(--c-f6f6f4)' : undefined }} data-testid={`deal-tile-${tile.status || 'total'}`}>
                    <span style={{ fontSize: 10, color: 'var(--c-444444)' }}>{tile.label}</span>
                    <strong style={{ fontSize: 18, color: 'var(--c-111111)' }}>{value}</strong>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </OpsState>
      {summary.state.status === 'ready' && summary.state.data.truncated ? <p role="status" style={{ fontSize: 11, color: 'var(--c-2a2a2a)' }}>This tenant has more deals than the counts read; filter by hotel to see exact numbers.</p> : null}

      <form aria-label="Deal filters" onSubmit={(event) => event.preventDefault()} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', margin: '8px 0', fontSize: 11, color: 'var(--c-444444)' }}>
        <label style={{ display: 'grid', gap: 2 }}>Search<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Code or name" maxLength={80} style={{ color: 'var(--c-111111)' }} /></label>
        <label style={{ display: 'grid', gap: 2 }}>Status
          <select value={status} onChange={(event) => { setStatus(event.target.value as HotelDealStatus | ''); setPage(1) }} style={{ color: 'var(--c-111111)' }}><option value="">All</option>{HOTEL_DEAL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
        </label>
        <label style={{ display: 'grid', gap: 2 }}>Type
          <select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }} style={{ color: 'var(--c-111111)' }}><option value="">All</option>{HOTEL_DEAL_KINDS.map((k) => <option key={k} value={k}>{HOTEL_DEAL_KIND_INFO[k].label}</option>)}</select>
        </label>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canManage ? <button type="button" className="admin-btn" onClick={sync} disabled={busy} title="Saves the started and ended labels that the hotel calendar already applies">{busy ? 'Updating…' : 'Update statuses'}</button> : null}
          {canManage ? <Link href={newHref} className="admin-btn admin-btn-primary">+ Create new promotion</Link> : null}
        </span>
      </form>
      {notice ? <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} style={{ margin: '8px 0', padding: notice.tone === 'ok' ? '8px 12px' : undefined }}>{notice.text}</div> : null}

      <OpsState state={list.state} onRetry={list.reload} isEmpty={(data) => data.items.length === 0}
        empty={{ title: 'No promotions yet', description: canManage ? 'Create a promotion and assign it to rate plans. It sells only after a second person approves it.' : 'No promotion matches. You can view promotions but not create them.' }}>
        {(data) => (
          <div className="workspace-panel" data-testid="deals-table">
            <ScrollRegion label="Promotions">
              <table style={tableStyle} aria-label="Promotions">
                <thead><tr>{['Code', 'Promotion', 'Hotel', 'Type', 'Status', 'Valid', 'Plans', 'Updated', ''].map((h, i) => <th key={i} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.items.map((deal) => (
                  <tr key={deal.id} data-testid={`deal-${deal.status.toLowerCase()}`}>
                    <td style={td}><code>{deal.code}</code></td>
                    <td style={td}><strong>{deal.name}</strong><div style={{ fontSize: 10 }}>v{deal.version}</div></td>
                    <td style={td}>{deal.hotelName}</td>
                    <td style={td}>{HOTEL_DEAL_KIND_INFO[deal.kind].label}</td>
                    <td style={td}><DealStatusTag status={deal.status} effective={deal.effectiveStatus} />{deal.statusReason ? <div style={{ fontSize: 10, maxWidth: 220 }}>{deal.statusReason}</div> : null}</td>
                    <td style={td}>{deal.activeFrom ?? 'on approval'} → {deal.activeTo ?? 'open'}</td>
                    <td style={td}>{deal.planCount}</td>
                    <td style={td}>{when(deal.updatedAt)}</td>
                    <td style={td}><Link href={`/commercial/promotions/${encodeURIComponent(deal.id)}`} className="admin-btn" aria-label={`Open ${deal.code}`}>Open</Link></td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </section>
  )
}
