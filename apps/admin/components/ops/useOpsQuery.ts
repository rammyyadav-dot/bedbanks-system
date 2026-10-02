'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { classifyOpsFailure, failureReference, type OpsFailure } from '@/lib/ops-state'

export type OpsQueryState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; failure: OpsFailure; reference: string | null }

/**
 * Loads one operations view. A failure is kept as a failure (never converted to empty data) and a stale
 * response from a superseded request is discarded so filters cannot show another query's rows.
 */
export function useOpsQuery<T>(load: () => Promise<T>, deps: ReadonlyArray<unknown>) {
  const [state, setState] = useState<OpsQueryState<T>>({ status: 'loading' })
  const sequence = useRef(0)
  const [nonce, setNonce] = useState(0)
  const loader = useCallback(load, deps)
  useEffect(() => {
    const id = ++sequence.current
    setState({ status: 'loading' })
    loader().then(
      data => { if (id === sequence.current) setState({ status: 'ready', data }) },
      error => { if (id === sequence.current) setState({ status: 'failed', failure: classifyOpsFailure(error), reference: failureReference(error) }) },
    )
    return () => { sequence.current++ }
  }, [loader, nonce])
  return { state, reload: () => setNonce(n => n + 1) }
}
