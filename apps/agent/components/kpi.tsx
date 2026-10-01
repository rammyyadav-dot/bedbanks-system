'use client'

export function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="portal-kpi"><span>{label}</span><strong className={tone ?? ''}>{value}</strong><small>{tone === 'amber' ? 'Needs attention' : 'Current status'}</small></div>
}
