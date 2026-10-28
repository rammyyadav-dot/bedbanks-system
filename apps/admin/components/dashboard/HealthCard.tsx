import { HealthBadge } from '../status/HealthBadge';
import type { SystemStatus } from '../../lib/types/admin';

export function HealthCard({ items }: { items: SystemStatus[] }) {
  return (
    <div className="panel">
      <div className="panel-header"><h2>System Status</h2></div>
      <div style={{ padding: '0 18px 16px' }}>
        {items.map((item) => (
          <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderTop: '1px solid var(--c-e4e4e0)' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--c-444444)' }}>{item.name}</div>
              <div style={{ fontSize: 9, color: 'var(--c-6b6b6b)', marginTop: 3 }}>{item.detail}</div>
            </div>
            <HealthBadge state={item.state} />
          </div>
        ))}
      </div>
    </div>
  );
}
