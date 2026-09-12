import type { ReactNode } from 'react';

export function TableToolbar({ children }: { children: ReactNode }) {
  return <div className="admin-filter-bar">{children}</div>;
}
