import type { ReactNode } from 'react'
import { formatMinorUnits, isMinorUnits } from '@/lib/minor-units'

/** Integer minor units + ISO currency, formatted for display only (never parsed as a float). */
export function Money({ minor, currency }: { minor: string | null; currency: string }) {
  if (minor === null) return <span>—</span>
  return <span className="mono" title={`${minor} ${currency} (minor units)`}>{isMinorUnits(minor.replace(/^-/, '')) ? (minor.startsWith('-') ? `-${formatMinorUnits(minor.slice(1), currency)}` : formatMinorUnits(minor, currency)) : minor}</span>
}

export function Tag({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'bad' | 'neutral'; children: ReactNode }) {
  const colors = { ok: ['#e6f7f2', '#0b6b55'], warn: ['#fff4dc', '#8a5a00'], bad: ['#fde8e8', '#a11d1d'], neutral: ['#eef3f4', '#2c4a55'] }[tone]
  return <span style={{ background: colors[0], color: colors[1], padding: '2px 8px', borderRadius: 10, font: "600 10px 'Courier New', monospace", whiteSpace: 'nowrap' }}>{children}</span>
}

export const bookingTone = (status: string) => (status === 'CONFIRMED' ? 'ok' : status === 'PENDING' ? 'warn' : status === 'FAILED' ? 'bad' : 'neutral') as 'ok' | 'warn' | 'bad' | 'neutral'
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

/** Plain-language meaning of each consistency flag, so an operator knows what to check. */
export const ATTENTION_HELP: Record<string, string> = {
  RECONCILIATION_REQUIRED: 'Attempt claimed inventory and stalled. Run reconciliation (idempotent).',
  PREBOOK_EXPIRED_UNRESOLVED: 'Supplier prebook succeeded but was never confirmed inside its window.',
  FINANCIAL_MISMATCH: 'Confirmed booking with no DEBIT in the wallet ledger.',
  INVENTORY_MISMATCH: 'Confirmed booking whose inventory hold is not CONFIRMED.',
  INVENTORY_NOT_RELEASED: 'Failed or cancelled booking whose inventory hold was not released.',
  REFUND_MISSING: 'Cancellation records a refund that the ledger does not show.',
  CANCELLATION_RECORD_MISSING: 'Booking is CANCELLED but has no cancellation record.',
}
export function AttentionTags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return <span style={{ color: '#6b8187' }}>—</span>
  return <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{flags.map(f => <span key={f} title={ATTENTION_HELP[f]}><Tag tone="bad">{f}</Tag></span>)}</span>
}
