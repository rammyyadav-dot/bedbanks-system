'use client'

import { useEffect } from 'react'
import { registerUnsaved } from './unsaved-guard'

/** Protect an editable hotel draft while `dirty`: reload and close, link clicks, Back/Forward and programmatic navigation (see unsaved-guard.ts). */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => (dirty ? registerUnsaved() : undefined), [dirty])
}
