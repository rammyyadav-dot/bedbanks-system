'use client'

import { useState } from 'react'
import type { HotelReportQuery } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money } from '@/components/ops/ops-ui'
import { apiDownload } from '@/lib/api/client'
import { getHotelReport } from '@/lib/data/hotel-commercial'
import { ScrollRegion, tableStyle, td, th } from '../ui'

const field = { display: 'grid', gap: 4, fontSize: 12 } as const
/** No fabricated chart data: the report and export share one scoped backend calculation. */
export function ReportsPanel({ hotelId }: { hotelId: string }) {
  const [draft, setDraft] = useState<HotelReportQuery>({ from: '', to: '', dateBasis: 'booking', supplier: '' })
  const [query, setQuery] = useState<HotelReportQuery | null>(null)
  const [error, setError] = useState<string | null>(null)
  return <div style={{ display: 'grid', gap: 16 }}>
    <form className="workspace-panel" aria-label="Hotel report filters" style={{ padding: 18, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }} onSubmit={e => {
      e.preventDefault()
      if (!draft.from || !draft.to || draft.from > draft.to) { setError('Choose a valid date range.'); return }
      setError(null); setQuery({ ...draft, supplier: draft.supplier?.trim() || undefined })
    }}>
      <label style={field}>From<input type="date" required value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
      <label style={field}>To<input type="date" required value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
      <label style={field}>Date basis<select value={draft.dateBasis} onChange={e => setDraft({ ...draft, dateBasis: e.target.value as HotelReportQuery['dateBasis'] })}><option value="booking">Booking date (UTC)</option><option value="stay">Stay date (hotel local)</option></select></label>
      <label style={field}>Supplier code (exact match)<input value={draft.supplier ?? ''} maxLength={80} placeholder="All suppliers" onChange={e => setDraft({ ...draft, supplier: e.target.value })} /></label>
      <button type="submit" className="button primary">Run report</button>
      {error && <p role="alert">{error}</p>}
    </form>
    {query ? <ReportResult key={JSON.stringify(query)} hotelId={hotelId} query={query} /> : <section className="workspace-panel" style={{ padding: 18 }}><h2 style={{ fontSize: 14 }}>Room nights, revenue and guest nationality</h2><p>Select dates and run a report. Reports use saved booking evidence and include only this hotel.</p></section>}
  </div>
}
function ReportResult({ hotelId, query }: { hotelId: string; query: HotelReportQuery }) {
  const { state, reload } = useOpsQuery(() => getHotelReport(hotelId, { ...query }), [hotelId, query.from, query.to, query.dateBasis, query.supplier])
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportQuery = new URLSearchParams({ from: query.from, to: query.to, dateBasis: query.dateBasis, ...(query.supplier ? { supplier: query.supplier } : {}) })
  async function download() {
    if (exportBusy) return
    setExportBusy(true); setExportError(null)
    try {
      const { blob } = await apiDownload(`/admin/operations/hotels/${encodeURIComponent(hotelId)}/reports/export?${exportQuery}`)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = 'hotel-report.csv'
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url)
    } catch (error) { setExportError(error instanceof Error ? error.message : 'The report could not be exported.') }
    finally { setExportBusy(false) }
  }
  return <OpsState state={state} onRetry={reload}>{report => <>
    <section className="workspace-panel" style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><h2 style={{ fontSize: 14, margin: 0 }}>Hotel report</h2><button type="button" className="admin-btn" disabled={exportBusy} onClick={() => void download()}>{exportBusy ? 'Exporting…' : 'Export CSV'}</button></div>
      {exportError && <p role="alert">{exportError}</p>}
      <p>{report.totalReservations} reservations · {report.roomNights} contracted room nights · {report.cancelledReservations} cancelled</p>
      {report.totalReservations === 0 && <p role="status">No reservations match these filters.</p>}
      {report.unknownRoomNightReservations > 0 && <p role="status">{report.unknownRoomNightReservations} reservations have insufficient room or date evidence for room-night totals.</p>}
      <ScrollRegion label="Hotel revenue"><table style={tableStyle}><caption>Revenue by original currency (reporting currency matches; conversion rate 1)</caption><thead><tr>{['Currency', 'Gross booking value', 'Net supplier cost', 'Margin', 'Cancelled booking value', 'Refund entitlement', 'Cancellation penalties', 'Taxes'].map(label => <th key={label} style={th} scope="col">{label}</th>)}</tr></thead><tbody>{report.currencies.map(g => <tr key={g.currency}><td style={td}>{g.currency}</td>{[g.grossMinor, g.netMinor, g.marginMinor, g.cancelledGrossMinor, g.refundMinor, g.penaltyMinor, g.taxesMinor].map((v, i) => <td key={i} style={td}>{v === null ? 'Unavailable' : <Money minor={v} currency={g.currency} />}</td>)}</tr>)}</tbody></table></ScrollRegion>
    </section>
    <section className="workspace-panel" style={{ padding: 18 }}><h2 style={{ fontSize: 14 }}>Guest nationality</h2><ul>{report.nationality.map(n => <li key={n.nationality}>{n.nationality}: {n.guests} recorded guests</li>)}</ul><p>{report.definitions.nationality}</p></section>
    <section className="workspace-panel" style={{ padding: 18 }}><h2 style={{ fontSize: 14 }}>Metric definitions and data coverage</h2><dl>{Object.entries(report.definitions).map(([label, value]) => <div key={label} style={{ marginBottom: 10 }}><dt style={{ fontWeight: 600 }}>{label}</dt><dd style={{ marginLeft: 0 }}>{value}</dd></div>)}</dl><ul>{report.limitations.map(l => <li key={l}>{l}</li>)}</ul></section>
  </>}</OpsState>
}
