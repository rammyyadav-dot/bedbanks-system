'use client'

import { useCallback, useEffect, useState } from 'react'
import { routes, type TenantControlDetail, type TenantControlPermission } from '@bedbanks/contracts'
import { apiRequest } from '@/lib/api/client'
import { tenantApiPath } from '@/lib/tenants-ui'

export function useTenantControl(id: string) {
  const [data, setData] = useState<TenantControlDetail | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await apiRequest<TenantControlDetail>(tenantApiPath(routes.platform.tenantSummary, id)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tenant unavailable')
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  const can = (permission: TenantControlPermission) => Boolean(data?.permissions.includes(permission))

  async function mutate(route: string, body: unknown, method = 'POST', extra?: Record<string, string>) {
    setBusy(true)
    setNotice('')
    setError('')
    try {
      await apiRequest(tenantApiPath(route, id, extra), {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(body),
      })
      setNotice('Change recorded.')
      await load()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Change failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { data, error, notice, busy, load, mutate, can }
}
