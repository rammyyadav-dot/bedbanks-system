import type { HotelContentQuality, HotelDuplicateCandidate } from '@bedbanks/contracts'
import Link from 'next/link'
import { hotelHref } from '@/lib/hotel-ui'

const BASIS: Record<HotelDuplicateCandidate['basis'][number], string> = {
  SAME_EXTERNAL_ID: 'shares an external identifier',
  NEAR_LOCATION_SIMILAR_NAME: 'similar name within 150 m',
  SAME_POSTAL_SIMILAR_NAME: 'similar name, same postal code',
}

/** Advisory content grade and possible duplicates as computed by the API (ADR 0057). Neither blocks publication. */
export function ContentQuality({ quality, duplicates, hotelId }: { quality: HotelContentQuality; duplicates: HotelDuplicateCandidate[]; hotelId: string }) {
  const open = quality.signals.filter((s) => !s.met)
  return (
    <section aria-label="Content quality" data-testid="content-quality">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Content quality: <span data-testid="quality-tier">{quality.tier}</span> ({quality.score}/100)</h2>
      <p style={{ fontSize: 12, color: '#3f565c', margin: '0 0 6px' }}>Advisory. It guides content work and never blocks publication.</p>
      {open.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 3, fontSize: 12 }}>
          {open.map((s) => <li key={s.key} data-signal={s.key}>+{s.weight} {s.label} <Link href={hotelHref(hotelId, s.tab)}>Improve</Link></li>)}
        </ul>
      )}
      {duplicates.length > 0 && (
        <div role="alert" data-testid="possible-duplicates" style={{ marginTop: 10, fontSize: 12, color: '#8a1c1c' }}>
          <strong>Possible duplicate{duplicates.length > 1 ? 's' : ''} in this tenant.</strong> Review before publishing or mapping:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {duplicates.map((d) => <li key={d.hotelId}><Link href={hotelHref(d.hotelId, 'setup')}>{d.name}</Link>, {d.city} ({d.status}) — {d.basis.map((b) => BASIS[b]).join('; ')}{d.distanceMetres !== null ? `, ${d.distanceMetres} m away` : ''}</li>)}
          </ul>
        </div>
      )}
    </section>
  )
}
