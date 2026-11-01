'use client'

/** Server-side pagination controls. The total comes from the API, never from the rows in hand. */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="admin-pagination" data-testid="pager">
      <span>{total} result{total === 1 ? '' : 's'} · page {page} of {pages}</span>
      <div className="admin-pagination-controls">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
      </div>
    </div>
  )
}
