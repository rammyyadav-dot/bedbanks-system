import type { LucideIcon } from 'lucide-react';

export function KPI({ label, value, icon: Icon, tone = 'cyan' }: { label: string; value: string; icon: LucideIcon; tone?: 'cyan' | 'amber' | 'blue' | 'green' }) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span className="metric-label">{label}</span>
        <span className={`metric-icon ${tone}`}><Icon size={14} /></span>
      </div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
