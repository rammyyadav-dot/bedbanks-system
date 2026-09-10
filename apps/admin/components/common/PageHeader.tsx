import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow, title, description, actions,
}: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="admin-page-header">
      <div>
        <div className="admin-eyebrow"><i className="status-dot" style={{ background: '#22c4a5', width: 6, height: 6, borderRadius: '50%', display: 'inline-block' }} />{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="admin-page-actions">{actions}</div>}
    </div>
  );
}
