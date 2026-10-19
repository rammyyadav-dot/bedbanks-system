'use client'

import { PRICE_GUARDRAIL } from '@bedbanks/contracts'

/**
 * Price-change guardrail (ADR 0067, F-13). Lists the prices a preview flagged as moving by more than the guardrail and asks for an explicit
 * confirmation before apply. The API refuses the apply without it; this only makes the question visible.
 */
export function LargeChangeConfirm({ warnings, confirmed, onChange }: { warnings: string[]; confirmed: boolean; onChange: (value: boolean) => void }) {
  if (warnings.length === 0) return null
  return (
    <div role="alert" className="admin-error" style={{ padding: 10, fontSize: 12, display: 'grid', gap: 6 }} data-testid="large-price-changes">
      <strong>{warnings.length} price{warnings.length === 1 ? '' : 's'} change by more than {PRICE_GUARDRAIL.maxChangeBp / 100}%.</strong>
      <ul style={{ margin: 0 }}>{warnings.slice(0, 10).map((w) => <li key={w}>{w}</li>)}{warnings.length > 10 ? <li>and {warnings.length - 10} more</li> : null}</ul>
      <label><input type="checkbox" checked={confirmed} onChange={(e) => onChange(e.target.checked)} /> I have checked these prices and want to apply them</label>
    </div>
  )
}
