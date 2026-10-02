'use client'

import Link from 'next/link'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getMarkupImpact } from '@/lib/data/commercial'
import { formatMinorUnits } from '@/lib/minor-units'
import { hotelHref, listHref } from '@/lib/hotel-ui'

/**
 * What the active rules do to the rate plans, as counted by the API. Nothing is priced here: every figure is the API's,
 * currencies stay separate, and amounts are formatted from integer minor units only.
 */
export function MarkupImpact({ version }: { version: number }) {
  const { state, reload } = useOpsQuery(() => getMarkupImpact(), [version])
  return (
    <section aria-labelledby="markup-impact" style={{ margin: '8px 0 12px' }} data-testid="markup-impact">
      <h2 id="markup-impact" style={{ fontSize: 14, margin: '0 0 6px' }}>Impact on rate plans</h2>
      <OpsState state={state} onRetry={reload}>
        {(i) => (
          <>
            <p style={{ color: '#3f565c', fontSize: 11, margin: '0 0 6px' }}>Plan-nights of active rate plans, {i.window.from} to {i.window.to} ({i.window.days} nights){i.scanCapped ? '. Counts cover the first alphabetical hotels only.' : '.'}</p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
              {[
                { label: 'NET priced by a rule', value: i.planNights.netPriced },
                { label: 'NET with no rule (not sellable)', value: i.planNights.netUnpriced, href: listHref({ issue: 'CURRENCY_OR_BASIS' }) },
                { label: 'Stored sell rates', value: i.planNights.sell },
                { label: 'Basis not verified (not sellable)', value: i.planNights.basisUnverified, href: listHref({ issue: 'CURRENCY_OR_BASIS' }) },
              ].map((t) => (
                <li key={t.label} className="workspace-panel" style={{ padding: '10px 14px' }}>
                  {t.href ? <Link href={t.href} style={{ textDecoration: 'none', color: 'inherit' }}><strong style={{ font: '700 20px system-ui', color: '#17333e' }}>{t.value}</strong><div style={{ fontSize: 11, color: '#3f565c' }}>{t.label}</div></Link>
                    : <><strong style={{ font: '700 20px system-ui', color: '#17333e' }}>{t.value}</strong><div style={{ fontSize: 11, color: '#3f565c' }}>{t.label}</div></>}
                </li>
              ))}
            </ul>
            {i.currencies.length > 0 && <p style={{ fontSize: 11, color: '#3f565c' }}>Priced NET nights: {i.currencies.map((c) => `${c.currency} cost ${formatMinorUnits(c.netMinor, c.currency)}, markup ${formatMinorUnits(c.markupMinor, c.currency)}`).join(' · ')}</p>}
            {i.affectedHotelCount > 0 && (
              <p style={{ fontSize: 11, color: '#3f565c' }}>
                {i.affectedHotelCount} hotel(s) have NET rates with no rule: {i.affectedHotels.map((h) => <Link key={h.hotelId} href={hotelHref(h.hotelId, 'rates')} style={{ marginRight: 8 }}>{h.hotelName} ({h.unpricedNights})</Link>)}
              </p>
            )}
          </>
        )}
      </OpsState>
    </section>
  )
}
