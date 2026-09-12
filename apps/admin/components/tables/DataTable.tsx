'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '../common/EmptyState';
import { LoadingState } from '../common/LoadingState';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

/**
 * Generic, reusable data table (spec section 47): one implementation,
 * configured per-module with columns + data, instead of a bespoke
 * table per page. Handles search, pagination, empty/loading state, and
 * row click — sorting UI is left to column headers if a page needs it.
 */
export function DataTable<T>({
  columns, data, loading, getRowId, onRowClick, pageSize = 8, emptyTitle = 'No results found', emptyDescription = 'Try changing your filters or search criteria.',
}: {
  columns: DataTableColumn<T>[];
  data: T[];
  loading?: boolean;
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(data.length / pageSize));
  const rows = useMemo(() => data.slice(page * pageSize, page * pageSize + pageSize), [data, page, pageSize]);

  if (loading) return <LoadingState rows={pageSize} />;
  if (data.length === 0) return <div className="workspace-panel"><EmptyState title={emptyTitle} description={emptyDescription} /></div>;

  return (
    <div className="workspace-panel">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={{
                    textAlign: col.align ?? 'left', padding: '10px 18px', color: '#92a5a9',
                    font: "8px 'Courier New', monospace", letterSpacing: '.8px', borderBottom: '1px solid #e6eef0', whiteSpace: 'nowrap',
                  }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={getRowId(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ borderBottom: '1px solid #edf2f3', cursor: onRowClick ? 'pointer' : 'default' }}
                className={onRowClick ? 'hotel-row' : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} style={{ textAlign: col.align ?? 'left', padding: '12px 18px', color: '#2c4a55', verticalAlign: 'middle' }}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="admin-pagination">
        <span>{data.length} result{data.length === 1 ? '' : 's'} · page {page + 1} of {pageCount}</span>
        <div className="admin-pagination-controls">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">‹</button>
          <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} aria-label="Next page">›</button>
        </div>
      </div>
    </div>
  );
}
