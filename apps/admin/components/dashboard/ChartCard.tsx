import type { ReactNode } from 'react';

/**
 * Minimal CSS/SVG bar visualization — no chart dependency added, per
 * spec section 46 ("do not add a heavy chart dependency solely for
 * decorative charts").
 */
export function ChartCard({ title, subtitle, bars, actions }: { title: string; subtitle: string; bars: { label: string; value: number }[]; actions?: ReactNode }) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker"><i className="status-dot" style={{ background: '#22c4a5', width: 6, height: 6, borderRadius: '50%', display: 'inline-block' }} /></div>
          <h2>{title}</h2>
        </div>
        {actions}
      </div>
      <div style={{ padding: '4px 18px 18px', color: '#7c949a', fontSize: 10 }}>{subtitle}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '0 18px 20px', height: 120 }}>
        {bars.map((bar) => (
          <div key={bar.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ width: '100%', height: Math.max(6, (bar.value / max) * 90), background: '#18bed0', borderRadius: 3 }} title={`${bar.label}: ${bar.value}`} />
            <span style={{ fontSize: 8, color: '#92a5a9', fontFamily: "'Courier New', monospace" }}>{bar.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
