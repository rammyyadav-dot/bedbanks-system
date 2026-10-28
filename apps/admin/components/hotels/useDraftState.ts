'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { mergeDraft } from '@/lib/hotel-setup-ui'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * An editor's draft next to the stored version it started from (`baseline`). The draft is never replaced behind the operator's back:
 *  - when the stored version moves (another editor saved, or the latest version was loaded), the draft is merged field by field onto it and any field
 *    that was edited in both places is reported in `conflicts` (the operator's value is kept);
 *  - after a save, `markSaved` adopts the server's normalised values for fields that were not edited again since submission, and keeps newer edits.
 */
export function useDraftState<T extends Record<string, unknown>>(baseline: T) {
  const [draft, setDraft] = useState<T>(baseline)
  const [conflicts, setConflicts] = useState<Array<keyof T>>([])
  const known = useRef(baseline)
  const current = useRef(draft); current.current = draft
  const key = JSON.stringify(baseline)

  useEffect(() => {
    if (same(known.current, baseline)) return
    const { merged, conflicts: clashing } = mergeDraft(known.current, current.current, baseline)
    known.current = baseline
    setDraft(merged); setConflicts(clashing)
  }, [key])

  const markSaved = useCallback((submitted: T, stored: T) => {
    known.current = stored
    setDraft(mergeDraft(submitted, current.current, stored).merged); setConflicts([])
  }, [])
  const reset = useCallback((to?: T) => { setDraft(to ?? known.current); setConflicts([]) }, [])
  /** Applies a restored draft: its own base is merged onto the stored version that is current now. */
  const restore = useCallback((storedBase: T, storedValue: T) => {
    const { merged, conflicts: clashing } = mergeDraft(storedBase, storedValue, known.current)
    setDraft(merged); setConflicts(clashing)
  }, [])

  return { draft, setDraft, dirty: !same(draft, baseline), conflicts, clearConflicts: () => setConflicts([]), markSaved, reset, restore }
}
