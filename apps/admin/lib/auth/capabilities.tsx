'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SupplyPermission } from '@bedbanks/contracts'
import { getCapabilities } from '@/lib/data'

/**
 * UX-only view of the caller's own supply permissions. The API remains the authorization boundary:
 * every endpoint re-checks its permission, so a stale or failed capability fetch can never grant access.
 * Until the keys are known (or if they cannot be loaded) controls stay visible and the API decides.
 */
type CapabilityState = { known: boolean; permissions: ReadonlySet<string> }
const CapabilityContext = createContext<CapabilityState>({ known: false, permissions: new Set() })

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CapabilityState>({ known: false, permissions: new Set() })
  useEffect(() => {
    let active = true
    getCapabilities().then(({ permissions }) => { if (active) setState({ known: true, permissions: new Set(permissions) }) }).catch(() => { /* leave unknown: API still enforces */ })
    return () => { active = false }
  }, [])
  return <CapabilityContext.Provider value={state}>{children}</CapabilityContext.Provider>
}

export function useCan() {
  const { known, permissions } = useContext(CapabilityContext)
  return useMemo(() => (permission: SupplyPermission) => !known || permissions.has(permission), [known, permissions])
}
