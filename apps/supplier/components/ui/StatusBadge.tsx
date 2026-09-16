import type { StatusTone } from '../../lib/types'

const inferredTones: Record<string, StatusTone> = {
  active: 'success', confirmed: 'success', loaded: 'success', mapped: 'success', approved: 'success',
  draft: 'neutral', pending: 'warning', 'review due': 'warning', 'action required': 'danger',
  unmapped: 'danger', 'not loaded': 'danger', 'needs attention': 'danger',
}

export function StatusBadge({ children, tone }: { children: string; tone?: StatusTone }) {
  const resolvedTone = tone ?? inferredTones[children.toLowerCase()] ?? 'info'
  return <span className={`status-badge ${resolvedTone}`}>{children}</span>
}
