import type { Status } from '../../lib/types/admin';

const LABEL: Record<Status, string> = { active: 'Active', inactive: 'Inactive', pending: 'Pending', suspended: 'Suspended' };
const CLASS: Record<Status, string> = { active: 'success', inactive: 'neutral', pending: 'warning', suspended: 'danger' };

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status-pill ${CLASS[status]}`}>
      <i className="status-dot" />
      {LABEL[status]}
    </span>
  );
}
