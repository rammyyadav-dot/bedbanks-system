import type { LucideIcon } from 'lucide-react'

export interface SummaryItem { label: string; value: string; hint?: string; icon: LucideIcon; tone: 'red' | 'green' | 'amber' | 'blue' }

/** Counts here are always derived from the rows actually loaded, and the hint says so. */
export function SummaryStrip({ items }: { items: SummaryItem[] }) {
  return (
    <div className="summary-grid">
      {items.map(({ icon: Icon, ...item }) => (
        <article key={item.label}>
          <span className={`summary-icon ${item.tone}`}><Icon size={20} aria-hidden="true" /></span>
          <div><small>{item.label}</small><strong>{item.value}</strong>{item.hint && <em>{item.hint}</em>}</div>
        </article>
      ))}
    </div>
  )
}
