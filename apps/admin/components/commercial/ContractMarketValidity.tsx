'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { describeApiError } from '@/lib/api/describe-error'
import { ScrollRegion, tableStyle, td, th } from '@/components/hotels/ui'
import {
  deleteContractMarketValidityRule,
  getContractMarketValidity,
  getRatePlans,
  getSourceMarketGroups,
  upsertContractMarketValidity,
  validateRatePlanMarket,
  type AdminRatePlan,
  type MarketValidityRuleRead,
  type SourceMarketGroupRead,
  type ValidateRatePlanMarketResult,
} from '@/lib/data'
import {
  ISO_COUNTRY_OPTIONS,
  blankRuleDraft,
  buildMarketValidityRuleWrite,
  describeEvaluationReason,
  describeMarketValidityRule,
  toggleCountrySelection,
  type RuleFormDraft,
} from '@/lib/market-validity-ui'

export interface SimulationRow {
  ratePlan: AdminRatePlan
  verdict: ValidateRatePlanMarketResult
}

/**
 * Contract & Rate Plan Validity Matrix and Live Source Market Simulator (ADR 0107).
 * Allows operators to attach INCLUDE / EXCLUDE rules (by country codes, source market group, or worldwide)
 * at the contract level or rate-plan level, and simulate a guest nationality / POS ISO code against all rate plans of the contract.
 */
export function ContractMarketValidity({
  contractId,
  contractCode,
  contractStatus,
  canManage,
  initialRules,
  onChanged,
}: {
  contractId: string
  contractCode: string
  contractStatus: string
  canManage: boolean
  initialRules?: MarketValidityRuleRead[]
  onChanged?: () => void
}) {
  const canEdit = canManage && contractStatus !== 'EXPIRED'
  const [rules, setRules] = useState<MarketValidityRuleRead[]>(initialRules ?? [])
  const [groups, setGroups] = useState<SourceMarketGroupRead[]>([])
  const [ratePlans, setRatePlans] = useState<AdminRatePlan[]>([])
  const [draft, setDraft] = useState<RuleFormDraft>(blankRuleDraft)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [simCountry, setSimCountry] = useState('AE')
  const [simRunning, setSimRunning] = useState(false)
  const [simResults, setSimResults] = useState<SimulationRow[] | null>(null)
  const [simTestedCountry, setSimTestedCountry] = useState<string | null>(null)

  async function loadAll() {
    setLoadError(null)
    try {
      const [loadedRules, loadedGroups, allPlans] = await Promise.all([
        getContractMarketValidity(contractId),
        getSourceMarketGroups(),
        getRatePlans(),
      ])
      const contractPlans = allPlans.filter((plan) => plan.contractId === contractId)
      setRules(loadedRules)
      setGroups(loadedGroups)
      setRatePlans(contractPlans)
      setDraft((curr) => ({
        ...curr,
        marketGroupId: curr.marketGroupId || loadedGroups[0]?.id || '',
      }))
    } catch (error) {
      setLoadError(describeApiError(error, 'load market validity configuration'))
    }
  }

  useEffect(() => {
    void loadAll()
  }, [contractId])

  const ratePlanCodeById = (ratePlanId: string) =>
    ratePlans.find((plan) => plan.id === ratePlanId)?.code ?? ratePlanId
  const groupById = (groupId: string) => groups.find((group) => group.id === groupId)

  async function handleAddRule(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    const built = buildMarketValidityRuleWrite(draft)
    if (typeof built === 'string') {
      setMessage({ kind: 'error', text: built })
      return
    }
    setBusy(true)
    try {
      await upsertContractMarketValidity(contractId, built)
      await loadAll()
      onChanged?.()
      setDraft((curr) => ({
        ...blankRuleDraft,
        marketGroupId: curr.marketGroupId || groups[0]?.id || '',
      }))
      setMessage({ kind: 'ok', text: 'Market validity rule attached.' })
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'attach market validity rule') })
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteRule(ruleId: string) {
    setBusy(true)
    setMessage(null)
    try {
      await deleteContractMarketValidityRule(contractId, ruleId)
      await loadAll()
      onChanged?.()
      setMessage({ kind: 'ok', text: 'Market validity rule removed.' })
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'remove market validity rule') })
    } finally {
      setBusy(false)
    }
  }

  async function runSimulation(event: FormEvent) {
    event.preventDefault()
    const country = simCountry.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country)) {
      setMessage({ kind: 'error', text: 'Enter a two-letter ISO 3166-1 alpha-2 country code (e.g. AE, IN, GB).' })
      return
    }
    setSimRunning(true)
    setMessage(null)
    try {
      const results: SimulationRow[] = await Promise.all(
        ratePlans.map(async (ratePlan) => ({
          ratePlan,
          verdict: await validateRatePlanMarket(ratePlan.id, country),
        }))
      )
      setSimTestedCountry(country)
      setSimResults(results)
    } catch (error) {
      setMessage({ kind: 'error', text: describeApiError(error, 'simulate source market validity') })
    } finally {
      setSimRunning(false)
    }
  }

  return (
    <section
      className="workspace-panel"
      style={{ maxWidth: 760, padding: 22, marginTop: 16, display: 'grid', gap: 14 }}
      aria-label="Market Validity & Source Market Simulator"
      data-testid="contract-market-validity-section"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ fontSize: 14, margin: 0 }}>Market Validity Matrix &amp; Source Market Simulator ({contractCode})</h2>
          <p style={{ fontSize: 11, color: 'var(--c-444444)', margin: '2px 0 0' }}>
            Explicit rate plan rules override contract-level rules. EXCLUDE rules take fail-safe precedence over INCLUDE rules. When no rule is attached, rate plans default to open worldwide.
          </p>
        </div>
        <Link href="/market-groups" className="admin-btn" style={{ fontSize: 11 }}>
          Manage Source Market Groups
        </Link>
      </div>

      {loadError ? (
        <p role="alert" style={{ fontSize: 12, color: 'var(--c-b3141b)', margin: 0 }}>
          {loadError}
        </p>
      ) : null}

      <div data-testid="market-validity-matrix">
        <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>Attached Market Validity Rules ({rules.length})</h3>
        {rules.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--c-444444)', margin: 0 }}>
            No market validity rules configured on this contract — rate plans default to open worldwide (`worldwide_default`).
          </p>
        ) : (
          <ScrollRegion label="Market validity rules">
            <table style={tableStyle} aria-label="Market validity rules">
              <thead>
                <tr>
                  <th scope="col" style={th}>Scope</th>
                  <th scope="col" style={th}>Rule Type</th>
                  <th scope="col" style={th}>Match Mode</th>
                  <th scope="col" style={th}>Source Markets</th>
                  {canEdit ? <th scope="col" style={th}>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const desc = describeMarketValidityRule(rule, ratePlanCodeById, groupById)
                  return (
                    <tr key={rule.id} data-testid={`validity-rule-row-${rule.id}`}>
                      <td style={{ ...td, fontWeight: 600 }}>{desc.scopeLabel}</td>
                      <td style={{ ...td, color: rule.inclusionType === 'EXCLUDE' ? 'var(--c-b3141b)' : 'var(--c-111111)', fontWeight: 600 }}>
                        {desc.actionLabel}
                      </td>
                      <td style={td}>{rule.matchType}</td>
                      <td style={td}>{desc.targetLabel}</td>
                      {canEdit ? (
                        <td style={td}>
                          <button
                            type="button"
                            className="admin-btn"
                            disabled={busy}
                            onClick={() => void handleDeleteRule(rule.id)}
                            aria-label={`Remove rule ${rule.id}`}
                          >
                            Remove
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </div>

      {canEdit ? (
        <form onSubmit={handleAddRule} style={{ display: 'grid', gap: 10, paddingTop: 8, borderTop: '1px solid var(--c-e4e4e0)' }} aria-label="Attach market validity rule" data-testid="add-market-validity-rule-form">
          <h3 style={{ fontSize: 12, margin: 0 }}>Attach Inclusion / Exclusion Rule</h3>
          <div className="admin-filter-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <select
              className="admin-filter-select"
              aria-label="Rule scope"
              value={draft.ratePlanId}
              onChange={(e) => setDraft({ ...draft, ratePlanId: e.target.value })}
              data-testid="rule-scope-select"
            >
              <option value="">Entire Contract (fallback for all plans)</option>
              {ratePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  Rate Plan: {plan.code} ({plan.roomType.name} · {plan.boardBasis.code})
                </option>
              ))}
            </select>

            <select
              className="admin-filter-select"
              aria-label="Inclusion type"
              value={draft.inclusionType}
              onChange={(e) => setDraft({ ...draft, inclusionType: e.target.value as RuleFormDraft['inclusionType'] })}
              data-testid="rule-inclusion-select"
            >
              <option value="INCLUDE">INCLUDE (Allow origin)</option>
              <option value="EXCLUDE">EXCLUDE (Block origin — Fail-safe)</option>
            </select>

            <select
              className="admin-filter-select"
              aria-label="Match type"
              value={draft.matchType}
              onChange={(e) => setDraft({ ...draft, matchType: e.target.value as RuleFormDraft['matchType'] })}
              data-testid="rule-match-type-select"
            >
              <option value="MARKET_GROUP">MARKET_GROUP (Named Geo-Bundle)</option>
              <option value="COUNTRY_CODE">COUNTRY_CODE (ISO 3166-1 alpha-2)</option>
              <option value="WORLDWIDE">WORLDWIDE (All origins)</option>
            </select>

            {draft.matchType === 'MARKET_GROUP' ? (
              <select
                className="admin-filter-select"
                aria-label="Source market group"
                value={draft.marketGroupId}
                onChange={(e) => setDraft({ ...draft, marketGroupId: e.target.value })}
                data-testid="rule-market-group-select"
              >
                <option value="">Select source market group…</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.code} · {group.name} ({group.countryCodes.join(', ')})
                  </option>
                ))}
              </select>
            ) : null}

            {draft.matchType === 'COUNTRY_CODE' ? (
              <input
                className="admin-filter-select"
                aria-label="ISO country codes (comma-separated)"
                placeholder="ISO codes (e.g. AE, SA, IN)"
                value={draft.customCountries}
                onChange={(e) => setDraft({ ...draft, customCountries: e.target.value.toUpperCase() })}
                data-testid="rule-custom-countries-input"
              />
            ) : null}

            <button type="submit" className="admin-btn admin-btn-primary" disabled={busy} data-testid="attach-validity-rule-btn">
              {busy ? 'Saving…' : 'Attach rule'}
            </button>
          </div>

          {draft.matchType === 'COUNTRY_CODE' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} role="group" aria-label="Quick select rule countries">
              {ISO_COUNTRY_OPTIONS.slice(0, 14).map((c) => {
                const selected = draft.selectedCountries.includes(c.code)
                return (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => setDraft((curr) => ({ ...curr, selectedCountries: toggleCountrySelection(curr.selectedCountries, c.code) }))}
                    aria-pressed={selected}
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 3,
                      border: selected ? '1px solid var(--c-111111)' : '1px solid var(--c-bdbdbd)',
                      background: selected ? 'var(--c-111111)' : 'transparent',
                      color: selected ? 'var(--c-ffffff)' : 'var(--c-111111)',
                      cursor: 'pointer',
                    }}
                  >
                    {c.code}
                  </button>
                )
              })}
            </div>
          ) : null}
        </form>
      ) : null}

      <div style={{ paddingTop: 10, borderTop: '1px solid var(--c-e4e4e0)', display: 'grid', gap: 10 }} data-testid="market-validity-simulator">
        <div>
          <h3 style={{ fontSize: 12, margin: 0 }}>Source Market Simulator Inspector</h3>
          <p style={{ fontSize: 11, color: 'var(--c-444444)', margin: '2px 0 0' }}>
            Test a guest nationality / POS ISO country code (e.g., <code>IN</code>, <code>AE</code>, <code>GB</code>) against this hotel contract to verify which rate plans are returned.
          </p>
        </div>

        <form onSubmit={runSimulation} className="admin-filter-bar" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="admin-filter-select"
            aria-label="Guest nationality ISO country code"
            value={simCountry}
            onChange={(e) => setSimCountry(e.target.value.toUpperCase())}
            maxLength={2}
            placeholder="e.g. AE or IN"
            style={{ width: 110, fontWeight: 600 }}
            data-testid="simulator-country-input"
          />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {['AE', 'SA', 'IN', 'GB', 'DE', 'RU', 'SG', 'US'].map((iso) => (
              <button
                key={iso}
                type="button"
                className="admin-btn"
                style={{ fontSize: 11, padding: '3px 7px' }}
                onClick={() => setSimCountry(iso)}
                data-testid={`sim-quick-${iso}`}
              >
                {iso}
              </button>
            ))}
          </div>
          <button
            type="submit"
            className="admin-btn admin-btn-primary"
            disabled={simRunning || ratePlans.length === 0}
            data-testid="run-market-simulator-btn"
          >
            {simRunning ? 'Evaluating…' : `Test Nationality (${simCountry || 'ISO'})`}
          </button>
        </form>

        {ratePlans.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--c-444444)', margin: 0 }}>
            This contract has no rate plans yet. Create rate plans on this contract to test market validity resolution.
          </p>
        ) : simResults && simTestedCountry ? (
          <div data-testid="simulator-results">
            <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 6px' }}>
              Simulation results for origin <code>{simTestedCountry}</code>: {simResults.filter((r) => r.verdict.isValid).length} of {simResults.length} rate plan(s) returned
            </p>
            <ScrollRegion label="Simulation results">
              <table style={tableStyle} aria-label="Simulation results">
                <thead>
                  <tr>
                    <th scope="col" style={th}>Rate Plan</th>
                    <th scope="col" style={th}>Room &amp; Board</th>
                    <th scope="col" style={th}>Plan Status</th>
                    <th scope="col" style={th}>Market Verdict</th>
                    <th scope="col" style={th}>Evaluation Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {simResults.map(({ ratePlan, verdict }) => (
                    <tr key={ratePlan.id} data-testid={`sim-result-${ratePlan.code}`}>
                      <td style={{ ...td, fontWeight: 600 }}>{ratePlan.code}</td>
                      <td style={td}>
                        {ratePlan.roomType.name} · {ratePlan.boardBasis.code}
                      </td>
                      <td style={td}>{ratePlan.status}</td>
                      <td
                        style={{
                          ...td,
                          fontWeight: 700,
                          color: verdict.isValid ? 'var(--c-111111)' : 'var(--c-b3141b)',
                        }}
                      >
                        {verdict.isValid ? 'VALID (RETURNED)' : 'RESTRICTED (BLOCKED)'}
                      </td>
                      <td style={td}>
                        {describeEvaluationReason(verdict.reason)}
                        {verdict.matchedRuleId ? ` (rule ${verdict.matchedRuleId.slice(0, 10)})` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </div>
        ) : null}
      </div>

      {message ? (
        <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ fontSize: 12, margin: 0, color: message.kind === 'error' ? 'var(--c-b3141b)' : 'var(--c-111111)' }}>
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
