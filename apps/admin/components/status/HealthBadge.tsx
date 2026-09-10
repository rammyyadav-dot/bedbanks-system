import type { HealthState } from '../../lib/types/admin';

const LABEL: Record<HealthState, string> = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down' };
const CLASS: Record<HealthState, string> = { healthy: 'success', degraded: 'warning', down: 'danger' };

export function HealthBadge({ state }: { state: HealthState }) {
  return (
    <span className={`status-pill ${CLASS[state]}`}>
      <i className="status-dot" />
      {LABEL[state]}
    </span>
  );
}
