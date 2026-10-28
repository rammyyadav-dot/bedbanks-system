'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getBookingRevenue } from '@/lib/data/booking-finance-postings'

/**
 * Booking revenue (ADR 0076): what the Finance consumer charged to agencies, refunded and owes to suppliers for Admin bookings, per currency. Read-only. Dated by when the
 * event was posted. Every figure is computed by the API; this page only shows it. Currencies are never added together.
 */
export default function BookingRevenuePage() {
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: '', to: '' })
  const q = useOpsQuery(() => getBookingRevenue(range), [range.from, range.to])
  const apply = (e: React.FormEvent) => { e.preventDefault(); setRange({ ...(draft.from ? { from: draft.from } : {}), ...(draft.to ? { to: draft.to } : {}) }) }
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · BOOKING REVENUE" title="Booking revenue" description="Sales, refunds, supplier cost and indicative margin of the Admin bookings the Finance consumer posted. Read-only; each currency is reported on its own." />
      <form onSubmit={apply} style={{ display: 'flex', gap: 10, alignItems: 'end', padding: '0 0 10px', flexWrap: 'wrap' }} aria-label="Report period">
        <label style={{ fontSize: 12 }}>From<br /><input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className="admin-input" /></label>
        <label style={{ fontSize: 12 }}>To (inclusive)<br /><input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className="admin-input" /></label>
        <button type="submit" className="admin-btn">Show</button>
        <span style={{ fontSize: 11, color: 'var(--c-444444)' }}>Empty dates mean this month to date. At most 366 days.</span>
      </form>
      <OpsState state={q.state} onRetry={q.reload} isEmpty={(d) => d.currencies.length === 0} empty={{ title: 'Nothing posted in this period', description: 'The query succeeded and the consumer posted no booking charge, refund or supplier accrual in these dates.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="booking-revenue">
            <p style={{ fontSize: 12, padding: '6px 14px', margin: 0 }}>Posted {d.from} to {d.to} (UTC).</p>
            {d.currencies.map((c) => (
              <section key={c.currency} aria-label={`${c.currency} revenue`} style={{ padding: '4px 14px 12px' }} data-testid={`revenue-${c.currency}`}>
                <h2 style={{ fontSize: 14, margin: '8px 0' }}>{c.currency}</h2>
                <dl style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: 0 }}>
                  {([['Sales', c.salesMinor], ['Refunds', c.refundsMinor], ['Net revenue', c.netRevenueMinor], ['Supplier cost', c.supplierCostMinor], ['Indicative margin', c.marginMinor]] as const).map(([label, minor]) => (
                    <div key={label}><dt style={{ fontSize: 11, color: 'var(--c-444444)' }}>{label}</dt><dd style={{ margin: 0, fontSize: 16, fontWeight: 600 }}><Money minor={minor} currency={c.currency} /></dd></div>
                  ))}
                  <div><dt style={{ fontSize: 11, color: 'var(--c-444444)' }}>Charging events</dt><dd style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{c.chargedEvents}</dd></div>
                </dl>
                <ScrollRegion label={`${c.currency} by agency`}>
                  <table style={tableStyle} aria-label={`${c.currency} revenue by agency`}>
                    <thead><tr>{['Agency', 'Sales', 'Refunds', 'Net revenue'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>{c.byAgency.map((r) => (
                      <tr key={r.agencyId ?? 'none'}>
                        <td style={td}>{r.name ?? (r.agencyId ? 'Unnamed agency' : 'No agency account')}</td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={r.salesMinor} currency={c.currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={r.refundsMinor} currency={c.currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={r.netRevenueMinor} currency={c.currency} /></td>
                      </tr>))}</tbody>
                  </table>
                </ScrollRegion>
                {c.bySupplier.length > 0 && (
                  <ScrollRegion label={`${c.currency} by supplier`}>
                    <table style={tableStyle} aria-label={`${c.currency} supplier cost`}>
                      <thead><tr>{['Supplier', 'Cost owed (net of reversals)'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                      <tbody>{c.bySupplier.map((r) => <tr key={r.supplierId}><td style={td}>{r.name ?? 'Unnamed supplier'}</td><td style={{ ...td, textAlign: 'right' }}><Money minor={r.costMinor} currency={c.currency} /></td></tr>)}</tbody>
                    </table>
                  </ScrollRegion>
                )}
              </section>
            ))}
            <ul style={{ fontSize: 11, color: 'var(--c-444444)', padding: '6px 30px' }}>{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
      </OpsState>
    </div>
  )
}
