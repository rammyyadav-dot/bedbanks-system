'use client'

import { useActionState } from 'react'
import type { ActionState } from '../../lib/actions'

export interface ShellOrganization {
  supplierId: string
  displayName: string
  type: string
}

export function OrganizationChooser({
  organizations,
  activeSupplierId,
  action,
}: {
  organizations: ShellOrganization[]
  activeSupplierId: string
  action: (previous: ActionState, formData: FormData) => Promise<ActionState>
}) {
  const [state, dispatch, pending] = useActionState(action, { error: null })

  return (
    <form action={dispatch} className="context-switcher" style={{ display: 'grid', gap: 8 }}>
      <label htmlFor="supplier-organization">Organization</label>
      <select id="supplier-organization" name="supplierId" defaultValue={activeSupplierId || organizations[0]?.supplierId}>
        {organizations.map((organization) => (
          <option key={organization.supplierId} value={organization.supplierId}>{organization.displayName}</option>
        ))}
      </select>
      <button className="btn" type="submit" disabled={pending}>Use organization</button>
      {state.error && <small role="alert">{state.error}</small>}
    </form>
  )
}
