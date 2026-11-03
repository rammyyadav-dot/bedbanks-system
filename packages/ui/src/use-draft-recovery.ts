'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { browserStorage, clearDraft, draftKey, readDraft, writeDraft } from './draft-store'

export interface RecoveredDraft<T> { savedAt: string; base: T; value: T }

/**
 * Keeps an editor's unsaved draft in this tab's sessionStorage so a reload, a tab change or a confirmed "leave" does not lose it, and offers it back
 * on return. `valid` checks the stored shape. `onRestore` receives the stored base and value; merging onto a newer stored version is the caller's job
 * (`mergeDraft`). The draft is cleared as soon as the editor is clean again, so a saved or discarded edit is never resurrected.
 * `recordId` scopes the draft (a hotel id, a quotation id, a tenant id for a not-yet-saved quotation). It is not an authority for tenant access.
 */
export function useDraftRecovery<T>({ scope, recordId, base, value, dirty, valid, onRestore }: {
  scope: string; recordId: string; base: T; value: T; dirty: boolean
  valid: (v: unknown) => v is T
  onRestore: (draft: RecoveredDraft<T>) => void
}) {
  const key = draftKey(scope, recordId)
  const [phase, setPhase] = useState<'init' | 'ready'>('init')
  const [recovered, setRecovered] = useState<{ savedAt: string } | null>(null)
  const restore = useRef(onRestore); restore.current = onRestore
  useEffect(() => {
    const stored = readDraft(browserStorage(), key, valid)
    if (stored) { restore.current(stored); setRecovered({ savedAt: stored.savedAt }) }
    setPhase('ready')
  }, [key])
  useEffect(() => {
    if (phase !== 'ready') return
    if (!dirty) { clearDraft(browserStorage(), key); return }
    writeDraft(browserStorage(), key, { base, value, savedAt: new Date().toISOString() })
  }, [phase, dirty, base, value, key])
  const dismiss = useCallback(() => setRecovered(null), [])
  return { recovered, dismiss }
}
