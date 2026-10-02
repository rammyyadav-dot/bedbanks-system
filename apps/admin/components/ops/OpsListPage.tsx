'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import type { Paged } from '@bedbanks/contracts'
import { OpsState } from './OpsState'
import { Pager } from './Pager'
import { useOpsQuery } from './useOpsQuery'

export interface FilterField { key: string; label: string; type: 'text' | 'select' | 'date' | 'checkbox'; options?: Array<{ value: string; label: string }>; placeholder?: string }
export interface OpsColumn<T> { key: string; header: string; render: (row: T) => ReactNode; align?: 'left' | 'right' }

const PAGE_SIZE = 25

/**
 * One server-paginated list: filters are sent to the API (never applied to rows in hand), a filter change returns to page 1,
 * and loading / error / empty are distinct states. The table is rendered only for a successful, non-empty response.
 */
export function OpsListPage<T>({ eyebrow, title, description, filters = [], load, columns, getRowId, emptyTitle, emptyDescription, actions }: {
  eyebrow: string; title: string; description: string
  filters?: FilterField[]
  load: (params: Record<string, string | number | boolean>) => Promise<Paged<T>>
  columns: OpsColumn<T>[]
  getRowId: (row: T) => string
  emptyTitle: string; emptyDescription: string
  actions?: ReactNode
}) {
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const [applied, setApplied] = useState<Record<string, string | boolean>>({})
  const [page, setPage] = useState(1)
  const params = useMemo(() => {
    const out: Record<string, string | number | boolean> = { page, pageSize: PAGE_SIZE }
    for (const [key, value] of Object.entries(applied)) if (value !== '' && value !== false) out[key] = value as string | boolean
    return out
  }, [applied, page])
  const { state, reload } = useOpsQuery(() => load(params), [params])

  return (
    <div className="admin-page">
      <PageHeader eyebrow={eyebrow} title={title} description={description} actions={actions} />
      {filters.length > 0 && (
        <form onSubmit={e => { e.preventDefault(); setApplied(draft); setPage(1) }} aria-label={`${title} filters`}>
          <TableToolbar>
            {filters.map(f => (
              <label key={f.key} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
                <span>{f.label}</span>
                {f.type === 'select' ? (
                  <select value={String(draft[f.key] ?? '')} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })}>
                    <option value="">All</option>
                    {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === 'checkbox' ? (
                  <input type="checkbox" checked={draft[f.key] === true} onChange={e => setDraft({ ...draft, [f.key]: e.target.checked })} />
                ) : (
                  <input type={f.type === 'date' ? 'date' : 'text'} maxLength={80} placeholder={f.placeholder} value={String(draft[f.key] ?? '')} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })} />
                )}
              </label>
            ))}
            <button type="submit" className="admin-btn">Apply</button>
            <button type="button" className="admin-btn" onClick={() => { setDraft({}); setApplied({}); setPage(1) }}>Clear</button>
          </TableToolbar>
        </form>
      )}
      <OpsState state={state} onRetry={reload} isEmpty={d => d.items.length === 0} empty={{ title: emptyTitle, description: emptyDescription }}>
        {data => (
          <div className="workspace-panel">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr>{columns.map(c => <th key={c.key} scope="col" style={{ textAlign: c.align ?? 'left', padding: '10px 14px', color: '#3f565c', borderBottom: '1px solid #e6eef0', whiteSpace: 'nowrap' }}>{c.header}</th>)}</tr></thead>
                <tbody>
                  {data.items.map(row => (
                    <tr key={getRowId(row)} style={{ borderBottom: '1px solid #edf2f3' }}>
                      {columns.map(c => <td key={c.key} style={{ textAlign: c.align ?? 'left', padding: '10px 14px', color: '#2c4a55', verticalAlign: 'middle' }}>{c.render(row)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}
