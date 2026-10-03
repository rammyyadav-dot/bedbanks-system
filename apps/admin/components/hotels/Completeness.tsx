import type { HotelCompleteness } from '@bedbanks/contracts'
import Link from 'next/link'
import { hotelHref } from '@/lib/hotel-ui'

const SECTION_TAB: Record<string, 'setup' | 'rooms'> = { identity: 'setup', location: 'setup', classification: 'setup', content: 'setup', operations: 'setup', contacts: 'setup', governance: 'setup', rooms: 'rooms' }

/** Publication requirements as computed by the API. Nothing here decides completeness; it lists what the server returned. */
export function Completeness({ completeness, hotelId, compact = false }: { completeness: HotelCompleteness; hotelId: string; compact?: boolean }) {
  const missing = completeness.requirements.filter((r) => !r.met)
  return (
    <section aria-label="Profile completeness" data-testid="profile-completeness">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Profile completeness</h2>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completeness.percent} aria-label={`Profile completeness ${completeness.percent} percent`} style={{ height: 8, background: '#e6eef0', borderRadius: 4, overflow: 'hidden', maxWidth: 360 }}>
        <div style={{ width: `${completeness.percent}%`, height: '100%', background: completeness.publishable ? '#0b6b55' : '#D90429' }} />
      </div>
      <p style={{ fontSize: 12, color: '#3f565c', margin: '6px 0' }} data-testid="completeness-summary">
        {completeness.met} of {completeness.total} publication requirements met{completeness.publishable ? ' — the profile can be published.' : '.'} A draft can be saved incomplete.
      </p>
      {(!compact || missing.length > 0) && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 3, fontSize: 12 }}>
          {(compact ? missing : completeness.requirements).map((r) => (
            <li key={r.key} data-requirement={r.key} data-met={r.met} style={{ color: r.met ? '#0b6b55' : '#8a1c1c' }}>
              <span aria-hidden="true">{r.met ? '✓' : '✗'}</span> <span className="sr-only">{r.met ? 'Met: ' : 'Missing: '}</span>{r.label}
              {!r.met && <> — <span style={{ color: '#3f565c' }}>{r.detail}</span> <Link href={hotelHref(hotelId, SECTION_TAB[r.section] ?? 'setup')}>Fix</Link></>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
