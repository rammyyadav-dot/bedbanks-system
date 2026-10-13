'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DepartmentPermission, OperationsPermission, SupplyPermission } from '@bedbanks/contracts'
import { getCapabilities } from '@/lib/data'
import { getOpsCapabilities } from '@/lib/data/operations'
import { isAllowed, loadingCapabilities, type CapabilityState, type CapabilityStatus } from './capability-policy'

/**
 * UX-only view of the caller's own permissions for the active tenant. The API remains the authorization boundary:
 * every endpoint re-checks its permission. The UI fails closed: nothing privileged is offered while capabilities are
 * loading, after a failed load, or if they were loaded for a different tenant than the one now active.
 */
const CapabilityContext = createContext<{ state: CapabilityState; tenantId: string | null }>({ state: loadingCapabilities(null), tenantId: null })

export function CapabilityProvider({ tenantId, children }: { tenantId: string | null; children: ReactNode }) {
  const [state, setState] = useState<CapabilityState>(() => loadingCapabilities(tenantId))
  useEffect(() => {
    let active = true
    // Reset immediately so permissions from the previous tenant are never applied to the new one.
    setState(loadingCapabilities(tenantId))
    Promise.all([getCapabilities(), getOpsCapabilities()])
      .then(([supply, ops]) => { if (active) setState({ status: 'ready', tenantId, permissions: new Set([...supply.permissions, ...ops.permissions]) }) })
      .catch(() => { if (active) setState({ status: 'error', tenantId, permissions: new Set() }) })
    return () => { active = false }
  }, [tenantId])
  const value = useMemo(() => ({ state, tenantId }), [state, tenantId])
  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>
}

export function useCan() {
  const { state, tenantId } = useContext(CapabilityContext)
  return useMemo(() => (permission: SupplyPermission | OperationsPermission | DepartmentPermission) => isAllowed(state, tenantId, permission), [state, tenantId])
}

/** Lets views show a loading or retry state instead of silently hiding controls. */
export function useCapabilityStatus(): CapabilityStatus {
  const { state, tenantId } = useContext(CapabilityContext)
  return state.tenantId === tenantId ? state.status : 'loading'
}
