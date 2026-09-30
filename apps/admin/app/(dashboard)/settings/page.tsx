'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Save } from 'lucide-react'
import {
  TENANT_SETTING_CURRENCIES, TENANT_SETTING_LANGUAGES, TENANT_SETTING_TIME_ZONES,
  type TenantSettingsView, type UpdateTenantSettingsRequest,
} from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { Tabs } from '@/components/common/Tabs'
import { FormField } from '@/components/forms/FormField'
import { AccessDenied, AdminLoadingState, AdminServiceUnavailable, AuthRequired } from '@/components/auth/AuthorizationStates'
import { ApiResponseError } from '@/lib/api/errors'
import { getTenantSettings, updateTenantSettings } from '@/lib/data'
import { formatMinorUnits, isMinorUnits } from '@/lib/minor-units'

type LoadError = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NETWORK' | 'API'
type SaveState = { kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string }

const LANGUAGE_LABELS: Record<string, string> = { en: 'English', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', hi: 'Hindi' }
const API_PATH = '/api/v1 (same-origin proxy)'

function toForm(view: TenantSettingsView): UpdateTenantSettingsRequest {
  return {
    name: view.name,
    supportEmail: view.supportEmail ?? '',
    defaultLanguage: view.defaultLanguage,
    timeZone: view.timeZone,
    defaultCurrency: view.defaultCurrency,
    lowBalanceThreshold: { ...view.lowBalanceThreshold },
  }
}

function loadError(cause: unknown): LoadError {
  if (!(cause instanceof ApiResponseError)) return 'API'
  if (cause.status === 401) return 'UNAUTHENTICATED'
  if (cause.status === 403) return 'FORBIDDEN'
  if (cause.code === 'NETWORK_ERROR') return 'NETWORK'
  return 'API'
}

function saveErrorMessage(cause: unknown): string {
  if (cause instanceof ApiResponseError) {
    if (cause.status === 403) return 'You no longer have permission to change settings.'
    if (cause.status === 409) return 'This save conflicted with an earlier request. Reload and try again.'
    if (cause.status === 400) return cause.message || 'Some values were rejected by the server.'
    if (cause.code === 'NETWORK_ERROR') return 'The Admin API could not be reached. Nothing was saved.'
  }
  return 'Settings could not be saved. Nothing was changed.'
}

export default function SettingsPage() {
  const [view, setView] = useState<TenantSettingsView | null>(null)
  const [form, setForm] = useState<UpdateTenantSettingsRequest | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })

  const load = useCallback(async () => {
    setError(null)
    try {
      const settings = await getTenantSettings()
      setView(settings)
      setForm(toForm(settings))
    } catch (cause) {
      setView(null)
      setError(loadError(cause))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const dirty = useMemo(() => Boolean(view && form && JSON.stringify(toForm(view)) !== JSON.stringify(form)), [view, form])
  const thresholdValid = form ? isMinorUnits(form.lowBalanceThreshold.amountMinor) : false
  const nameValid = Boolean(form?.name.trim())

  function update<K extends keyof UpdateTenantSettingsRequest>(key: K, value: UpdateTenantSettingsRequest[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current)
    setSave({ kind: 'idle' })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!form || !dirty || !thresholdValid || !nameValid) return
    setSave({ kind: 'saving' })
    try {
      const payload: UpdateTenantSettingsRequest = { ...form, name: form.name.trim(), supportEmail: form.supportEmail?.trim() || null }
      const saved = await updateTenantSettings(payload, crypto.randomUUID())
      setView(saved)
      setForm(toForm(saved))
      setSave({ kind: 'saved' })
    } catch (cause) {
      setSave({ kind: 'error', message: saveErrorMessage(cause) })
    }
  }

  if (error === 'FORBIDDEN') return <div className="admin-page"><AccessDenied permission="settings.manage" /></div>
  if (error === 'UNAUTHENTICATED') return <div className="admin-page"><AuthRequired /></div>
  if (error) return <div className="admin-page"><AdminServiceUnavailable network={error === 'NETWORK'} onRetry={() => void load()} /></div>
  if (!view || !form) return <div className="admin-page"><AdminLoadingState /></div>

  const threshold = form.lowBalanceThreshold
  const tabs = [
    { id: 'workspace', label: 'Workspace', content: <div className="workspace-panel settings-panel">
      <FormField label="WORKSPACE NAME"><input value={form.name} maxLength={120} required onChange={(event) => update('name', event.target.value)} /></FormField>
      {!nameValid ? <p className="settings-hint settings-status error">Workspace name is required.</p> : null}
      <FormField label="SUPPORT EMAIL"><input type="email" value={form.supportEmail ?? ''} placeholder="support@your-agency.com" onChange={(event) => update('supportEmail', event.target.value)} /></FormField>
      <p className="settings-hint">Shown to your team as the escalation contact. Leave empty to clear.</p>
      <FormField label="WORKSPACE SLUG"><input value={view.slug} readOnly /></FormField>
      <p className="settings-hint">The slug identifies this workspace and cannot be changed here.</p>
    </div> },
    { id: 'regional', label: 'Regional', content: <div className="workspace-panel settings-panel">
      <FormField label="DEFAULT LANGUAGE"><select value={form.defaultLanguage} onChange={(event) => update('defaultLanguage', event.target.value as UpdateTenantSettingsRequest['defaultLanguage'])}>{TENANT_SETTING_LANGUAGES.map((code) => <option key={code} value={code}>{LANGUAGE_LABELS[code] ?? code} ({code})</option>)}</select></FormField>
      <FormField label="TIME ZONE"><select value={form.timeZone} onChange={(event) => update('timeZone', event.target.value as UpdateTenantSettingsRequest['timeZone'])}>{TENANT_SETTING_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></FormField>
      <p className="settings-hint">Stored preferences for this workspace. Reporting ranges still use UTC until reports adopt this setting.</p>
    </div> },
    { id: 'commercial', label: 'Commercial', content: <div className="workspace-panel settings-panel">
      <FormField label="DEFAULT CURRENCY (ISO-4217)"><select value={form.defaultCurrency} onChange={(event) => update('defaultCurrency', event.target.value as UpdateTenantSettingsRequest['defaultCurrency'])}>{TENANT_SETTING_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select></FormField>
      <p className="settings-hint">Display and alert preference only. Wallets, ledger entries and existing bookings keep their own currencies; no FX conversion is applied.</p>
      <FormField label="LOW-BALANCE ALERT CURRENCY"><select value={threshold.currency} onChange={(event) => update('lowBalanceThreshold', { ...threshold, currency: event.target.value })}>{TENANT_SETTING_CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select></FormField>
      <FormField label={`LOW-BALANCE THRESHOLD (MINOR UNITS OF ${threshold.currency})`}><input inputMode="numeric" value={threshold.amountMinor} onChange={(event) => update('lowBalanceThreshold', { ...threshold, amountMinor: event.target.value.trim() })} /></FormField>
      <p className={`settings-hint${thresholdValid ? '' : ' settings-status error'}`}>{thresholdValid ? `Equals ${formatMinorUnits(threshold.amountMinor, threshold.currency)}. Alert delivery is not yet active; this stores the threshold only.` : 'Enter a whole number of minor units (for example 150000 for 1,500.00).'}</p>
    </div> },
    { id: 'system', label: 'System', content: <div className="workspace-panel settings-panel">
      <dl className="settings-readonly">
        <dt>TENANT ID</dt><dd>{view.tenantId}</dd>
        <dt>SLUG</dt><dd>{view.slug}</dd>
        <dt>STATUS</dt><dd>{view.status}</dd>
        <dt>API PATH</dt><dd>{API_PATH}</dd>
        <dt>LAST UPDATED</dt><dd>{new Date(view.updatedAt).toLocaleString()}</dd>
      </dl>
    </div> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="SETTINGS" title="Workspace settings" description="Workspace, regional and commercial preferences for your tenant. Changes are saved to the Admin API and recorded in the audit log." />
      <form onSubmit={onSubmit} noValidate>
        <Tabs tabs={tabs} />
        <div className="settings-savebar">
          <button type="submit" className="admin-btn admin-btn-primary" disabled={!dirty || !thresholdValid || !nameValid || save.kind === 'saving'}><Save size={14} />{save.kind === 'saving' ? 'Saving…' : 'Save changes'}</button>
          {dirty ? <button type="button" className="admin-btn" onClick={() => { setForm(toForm(view)); setSave({ kind: 'idle' }) }}>Discard</button> : null}
          <span role="status" className={`settings-status ${save.kind === 'error' ? 'error' : save.kind === 'saved' ? 'success' : ''}`}>
            {save.kind === 'error' ? save.message : save.kind === 'saved' ? 'Settings saved.' : dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
        </div>
      </form>
    </div>
  )
}
