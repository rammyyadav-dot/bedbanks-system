import type { StatusTone } from '../../lib/types'
import { statusLabel, statusTone } from '../../lib/status'

/** `children` is either a ready label or a raw API status key; the tone is derived from the key unless given. */
export function StatusBadge({ children, tone, raw }: { children: string; tone?: StatusTone; raw?: string }) {
  const resolvedTone = tone ?? statusTone(raw ?? children)
  return <span className={`status-badge ${resolvedTone}`}><i aria-hidden="true" />{raw ? statusLabel(raw) : children}</span>
}
