import type { RateFinding } from '@bedbanks/contracts'
import { Chip } from '@/components/hotels/ui'
import { severityTone } from '@/lib/rate-certification-ui'

/** Findings with their word label, count and a few sample dates or ids. Read-only: there is nothing to apply here. */
export function FindingList({ findings, emptyText = 'No findings.' }: { findings: RateFinding[]; emptyText?: string }) {
  if (findings.length === 0) return <p style={{ margin: 0, fontSize: 12, color: '#3f565c' }} data-testid="no-findings">{emptyText}</p>
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }} data-testid="findings">
      {findings.map((f) => (
        <li key={f.code} data-code={f.code} data-severity={f.severity} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'start', fontSize: 12 }}>
          <Chip tone={severityTone(f.severity)}>{f.severity}</Chip>
          <span><code>{f.code}</code> · {f.message}{f.count > 1 ? ` (${f.count})` : ''}{f.sample.length > 0 ? <span style={{ color: '#3f565c' }}> — e.g. {f.sample.join(', ')}</span> : null}</span>
        </li>
      ))}
    </ul>
  )
}
