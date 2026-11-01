'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { FormField } from '@/components/forms/FormField'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { ScrollRegion, tableStyle, td, th } from '@/components/hotels/ui'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import {
  deleteSourceMarketGroup,
  getSourceMarketGroups,
  updateSourceMarketGroup,
  upsertSourceMarketGroup,
  type SourceMarketGroupRead,
} from '@/lib/data'
import {
  ISO_COUNTRY_OPTIONS,
  SOURCE_MARKET_GROUP_PRESETS,
  mergeSelectedAndCustomCountries,
  toggleCountrySelection,
  type MarketGroupPreset,
} from '@/lib/market-validity-ui'

export default function SourceMarketGroupsPage() {
  const canManage = useCan()('supply.contracts.manage')
  const { state, reload } = useOpsQuery(() => getSourceMarketGroups(), [])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [selectedCountries, setSelectedCountries] = useState<string[]>(['AE', 'SA', 'QA', 'OM', 'BH', 'KW'])
  const [customCountries, setCustomCountries] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  function applyPreset(preset: MarketGroupPreset) {
    setEditingId(null)
    setCode(preset.code)
    setName(preset.name)
    setSelectedCountries(preset.countryCodes)
    setCustomCountries('')
    setIsActive(true)
    setMessage(null)
  }

  function startEdit(group: SourceMarketGroupRead) {
    setEditingId(group.id)
    setCode(group.code)
    setName(group.name)
    setSelectedCountries(group.countryCodes)
    setCustomCountries('')
    setIsActive(group.isActive)
    setMessage(null)
  }

  function resetForm() {
    setEditingId(null)
    setCode('')
    setName('')
    setSelectedCountries([])
    setCustomCountries('')
    setIsActive(true)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    const trimmedCode = code.trim().toUpperCase()
    const trimmedName = name.trim()
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(trimmedCode)) {
      setMessage({ kind: 'error', text: 'Group code must be 2 to 40 uppercase letters, digits, underscores or hyphens (e.g. GCC, DOMESTIC_IN).' })
      return
    }
    if (trimmedName.length < 2) {
      setMessage({ kind: 'error', text: 'Enter a descriptive name for the source market group.' })
      return
    }
    const { codes, invalid } = mergeSelectedAndCustomCountries(selectedCountries, customCountries)
    if (invalid.length > 0) {
      setMessage({ kind: 'error', text: `Invalid ISO 3166-1 alpha-2 country code(s): ${invalid.join(', ')}.` })
      return
    }
    if (codes.length === 0) {
      setMessage({ kind: 'error', text: 'Select at least one ISO country code for the group.' })
      return
    }

    setBusy(true)
    try {
      if (editingId) {
        await updateSourceMarketGroup(editingId, { code: trimmedCode, name: trimmedName, countryCodes: codes, isActive })
        setMessage({ kind: 'ok', text: `Updated source market group ${trimmedCode} (${codes.length} countries).` })
      } else {
        await upsertSourceMarketGroup({ code: trimmedCode, name: trimmedName, countryCodes: codes, isActive })
        setMessage({ kind: 'ok', text: `Saved source market group ${trimmedCode} (${codes.length} countries).` })
      }
      resetForm()
      reload()
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'save source market group') })
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleActive(group: SourceMarketGroupRead) {
    setBusy(true)
    setMessage(null)
    try {
      await updateSourceMarketGroup(group.id, { isActive: !group.isActive })
      setMessage({ kind: 'ok', text: `${group.code} is now ${!group.isActive ? 'active' : 'inactive'}.` })
      reload()
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'update group status') })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(group: SourceMarketGroupRead) {
    setBusy(true)
    setMessage(null)
    try {
      await deleteSourceMarketGroup(group.id)
      if (editingId === group.id) resetForm()
      setMessage({ kind: 'ok', text: `Removed source market group ${group.code}.` })
      reload()
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'delete source market group') })
    } finally {
      setBusy(false)
    }
  }

  const mergedPreview = mergeSelectedAndCustomCountries(selectedCountries, customCountries)

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="COMMERCIAL · SOURCE MARKET PROFILING"
        title="Source Market Groups"
        description="Define reusable geo-bundles of ISO 3166-1 alpha-2 country codes (e.g., GCC, CIS, Domestic India, EU Schengen) for contract and rate plan validity gating."
        actions={<Link href="/contracts" className="admin-btn">View contracts</Link>}
      />

      {canManage ? (
        <section className="workspace-panel" style={{ padding: 20, marginBottom: 16, display: 'grid', gap: 12 }} aria-label="Source Market Group Manager" data-testid="source-market-group-manager">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h2 style={{ fontSize: 14, margin: 0 }}>{editingId ? `Edit group ${code}` : 'Create or update source market group'}</h2>
              <p style={{ fontSize: 12, color: 'var(--c-444444)', margin: '2px 0 0' }}>Multi-select ISO 3166-1 alpha-2 origin countries or load a regional template.</p>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SOURCE_MARKET_GROUP_PRESETS.map((preset) => (
                <button
                  key={preset.code}
                  type="button"
                  className="admin-btn"
                  style={{ fontSize: 11, padding: '4px 8px' }}
                  onClick={() => applyPreset(preset)}
                  data-testid={`preset-${preset.code}`}
                >
                  Preset: {preset.code}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <FormField label="Group code (unique per tenant)">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g. GCC, CIS, DOMESTIC_IN"
                  maxLength={40}
                  required
                  data-testid="group-code-input"
                />
              </FormField>
              <FormField label="Group name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Gulf Cooperation Council"
                  maxLength={120}
                  required
                  data-testid="group-name-input"
                />
              </FormField>
              <FormField label="Additional ISO codes (comma-separated)">
                <input
                  value={customCountries}
                  onChange={(e) => setCustomCountries(e.target.value.toUpperCase())}
                  placeholder="e.g. JO, EG, LB"
                  data-testid="group-custom-countries-input"
                />
              </FormField>
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                Multi-select ISO 3166-1 alpha-2 origin countries ({mergedPreview.codes.length} selected: {mergedPreview.codes.join(', ') || 'none'})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="ISO country code selector">
                {ISO_COUNTRY_OPTIONS.map((c) => {
                  const active = selectedCountries.includes(c.code)
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => setSelectedCountries((curr) => toggleCountrySelection(curr, c.code))}
                      aria-pressed={active}
                      data-testid={`country-chip-${c.code}`}
                      style={{
                        fontSize: 11,
                        padding: '4px 8px',
                        borderRadius: 4,
                        border: active ? '1px solid var(--c-111111)' : '1px solid var(--c-bdbdbd)',
                        background: active ? 'var(--c-111111)' : 'transparent',
                        color: active ? 'var(--c-ffffff)' : 'var(--c-111111)',
                        cursor: 'pointer',
                      }}
                    >
                      <strong>{c.code}</strong> · {c.name}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Group is active for market validity evaluation
              </label>
              <button type="submit" className="admin-btn admin-btn-primary" disabled={busy} data-testid="save-market-group-btn">
                {busy ? 'Saving…' : editingId ? 'Update market group' : 'Save market group'}
              </button>
              {editingId ? (
                <button type="button" className="admin-btn" onClick={resetForm} disabled={busy}>
                  Cancel edit
                </button>
              ) : null}
            </div>
          </form>

          {message ? (
            <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ fontSize: 12, margin: 0, color: message.kind === 'error' ? 'var(--c-b3141b)' : 'var(--c-111111)' }}>
              {message.text}
            </p>
          ) : null}
        </section>
      ) : null}

      <OpsState
        state={state}
        onRetry={reload}
        isEmpty={(groups) => groups.length === 0}
        empty={{
          title: 'No source market groups defined',
          description: 'Create named geo-bundles (such as GCC, CIS, or Domestic India) above to attach source market validity rules to contracts and rate plans.',
        }}
      >
        {(groups) => (
          <div className="workspace-panel" data-testid="source-market-groups-table">
            <ScrollRegion label="Source Market Groups">
              <table style={tableStyle} aria-label="Source Market Groups">
                <thead>
                  <tr>
                    <th scope="col" style={th}>Code</th>
                    <th scope="col" style={th}>Group Name</th>
                    <th scope="col" style={th}>ISO Country Codes</th>
                    <th scope="col" style={th}>Count</th>
                    <th scope="col" style={th}>Status</th>
                    {canManage ? <th scope="col" style={th}>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.id} data-testid={`market-group-row-${group.code}`}>
                      <td style={{ ...td, fontWeight: 600 }}>{group.code}</td>
                      <td style={td}>{group.name}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {group.countryCodes.map((iso) => (
                            <span
                              key={iso}
                              style={{
                                display: 'inline-block',
                                padding: '1px 6px',
                                fontSize: 11,
                                fontWeight: 600,
                                borderRadius: 3,
                                border: '1px solid var(--c-bdbdbd)',
                              }}
                            >
                              {iso}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={td}>{group.countryCodes.length}</td>
                      <td style={td}>{group.isActive ? 'ACTIVE' : 'INACTIVE'}</td>
                      {canManage ? (
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button type="button" className="admin-btn" onClick={() => startEdit(group)} disabled={busy}>
                              Edit
                            </button>
                            <button type="button" className="admin-btn" onClick={() => void handleToggleActive(group)} disabled={busy}>
                              {group.isActive ? 'Deactivate' : 'Activate'}
                            </button>
                            <button type="button" className="admin-btn" onClick={() => void handleDelete(group)} disabled={busy}>
                              Delete
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </div>
        )}
      </OpsState>
    </div>
  )
}
