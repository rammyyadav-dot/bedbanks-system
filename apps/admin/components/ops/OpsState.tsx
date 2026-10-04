'use client'

import type { ReactNode } from 'react'
import { LoadingState } from '@/components/common/LoadingState'
import { EmptyState } from '@/components/common/EmptyState'
import { OPS_FAILURE_COPY } from '@/lib/ops-state'
import type { OpsQueryState } from './useOpsQuery'

/** Renders one of LOADING / ERROR (unauthenticated, forbidden, denied, unreachable, error) / EMPTY / the data. Distinct, never conflated. */
export function OpsState<T>({ state, isEmpty, empty, onRetry, children }: {
  state: OpsQueryState<T>
  isEmpty?: (data: T) => boolean
  empty?: { title: string; description: string }
  onRetry?: () => void
  children: (data: T) => ReactNode
}) {
  if (state.status === 'loading') return <LoadingState rows={6} />
  if (state.status === 'failed') {
    const copy = OPS_FAILURE_COPY[state.failure]
    return (
      <div className="admin-error" role="alert" data-state={state.failure}>
        <strong>{copy.title}</strong>
        <span>{copy.body}</span>
        {state.reference ? <span>Reference: <code>{state.reference}</code></span> : null}
        {onRetry && state.failure !== 'forbidden' && state.failure !== 'denied' && state.failure !== 'not-configured' ? <button type="button" className="admin-btn" onClick={onRetry}>Retry</button> : null}
      </div>
    )
  }
  if (isEmpty?.(state.data)) return <div className="workspace-panel" data-state="empty"><EmptyState title={empty?.title ?? 'No records'} description={empty?.description ?? 'The query succeeded and returned no records.'} /></div>
  return <>{children(state.data)}</>
}
