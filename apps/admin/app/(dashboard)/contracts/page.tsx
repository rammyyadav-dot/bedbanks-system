'use client'

import { useEffect, useState } from 'react'
import type { CancellationPolicySimulationResult, ContractPoliciesRead } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { DetailDrawer, DrawerField } from '@/components/dialogs/DetailDrawer'
import {
  getContracts,
  getContractPolicies,
  createContractCancellationPolicy,
  simulateContractCancellationPolicy,
  type AdminContract,
} from '@/lib/data'
import { buildCancellationPolicyWrite, buildCancellationSimulationPayload } from '@/lib/dubai-operations'
import { formatMinorUnits } from '@/lib/minor-units'

export default function ContractsPage() {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AdminContract | null>(null)
  const [allContracts, setContracts] = useState<AdminContract[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [policies, setPolicies] = useState<ContractPoliciesRead | null>(null)
  const [policiesLoading, setPoliciesLoading] = useState(false)
  const [policyMessage, setPolicyMessage] = useState<string | null>(null)
  const [daysBeforeCheckin, setDaysBeforeCheckin] = useState('3')
  const [penaltyMode, setPenaltyMode] = useState<'PERCENTAGE' | 'FIXED'>('PERCENTAGE')
  const [penaltyValue, setPenaltyValue] = useState('50')

  const [simCheckIn, setSimCheckIn] = useState('2026-12-31')
  const [simRequestedAt, setSimRequestedAt] = useState('2026-12-28T12:00:00Z')
  const [simPolicyType, setSimPolicyType] = useState<'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL'>('REFUNDABLE')
  const [simSemantics, setSimSemantics] = useState<'CALENDAR_DAYS_AT_LOCAL_TIME' | 'ELAPSED_HOURS'>('CALENDAR_DAYS_AT_LOCAL_TIME')
  const [simTimeZone, setSimTimeZone] = useState('Asia/Dubai')
  const [simLocalTime, setSimLocalTime] = useState('15:00')
  const [simAmount, setSimAmount] = useState('1000.00')
  const [simNightlyCsv, setSimNightlyCsv] = useState('')
  const [simPaidAmount, setSimPaidAmount] = useState('1000.00')
  const [simRetainedFees, setSimRetainedFees] = useState('0.00')
  const [simPriorRefunds, setSimPriorRefunds] = useState('0.00')
  const [simResult, setSimResult] = useState<CancellationPolicySimulationResult | null>(null)
  const [simError, setSimError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getContracts().then(rows => { if (active) setContracts(rows) }).catch(() => { if (active) { setContracts([]); setError(true) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selected) {
      setPolicies(null)
      setPolicyMessage(null)
      setSimResult(null)
      setSimError(null)
      return
    }
    let active = true
    setPoliciesLoading(true)
    setPolicyMessage(null)
    setSimResult(null)
    setSimError(null)
    getContractPolicies(selected.id)
      .then(data => { if (active) setPolicies(data) })
      .catch(() => { if (active) { setPolicies(null); setPolicyMessage('Contract policies are unavailable.') } })
      .finally(() => { if (active) setPoliciesLoading(false) })
    return () => { active = false }
  }, [selected])

  const addCancellationWindow = async () => {
    if (!selected) return
    try {
      const payload = buildCancellationPolicyWrite({
        daysBeforeCheckinValue: daysBeforeCheckin,
        mode: penaltyMode,
        penaltyValue,
        currency: selected.settlementCurrency,
      })
      await createContractCancellationPolicy(selected.id, payload)
      const refreshed = await getContractPolicies(selected.id)
      setPolicies(refreshed)
      setPolicyMessage('Added cancellation policy window.')
    } catch (err) {
      setPolicyMessage(err instanceof Error ? err.message : 'Unable to add cancellation policy window.')
    }
  }

  const runSimulation = async () => {
    if (!selected) return
    try {
      setSimError(null)
      const payload = buildCancellationSimulationPayload({
        checkIn: simCheckIn,
        requestedAt: simRequestedAt,
        currency: selected.settlementCurrency,
        cancellableAmountMajor: simAmount,
        nightlyAmountsMajorCsv: simNightlyCsv,
        customerAmountPaidMajor: simPaidAmount,
        retainedFeesMajor: simRetainedFees,
        priorRefundsMajor: simPriorRefunds,
        policyType: simPolicyType,
        deadlineSemantics: simSemantics,
        propertyTimeZone: simTimeZone,
        checkInLocalTime: simLocalTime,
      })
      const result = await simulateContractCancellationPolicy(selected.id, payload)
      setSimResult(result)
    } catch (err) {
      setSimResult(null)
      setSimError(err instanceof Error ? err.message : 'Simulation failed.')
    }
  }

  const filtered = allContracts.filter((c) => c.code.toLowerCase().includes(search.toLowerCase()) || c.supplier.displayName.toLowerCase().includes(search.toLowerCase()))

  const columns: DataTableColumn<AdminContract>[] = [
    { key: 'supplier', header: 'Supplier', render: (c) => c.supplier.displayName },
    { key: 'name', header: 'Contract', render: (c) => c.code },
    { key: 'validity', header: 'Validity', render: (c) => `${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)}` },
    { key: 'currency', header: 'Currency', render: (c) => c.settlementCurrency },
    { key: 'status', header: 'Status', render: (c) => <span>{c.status}</span> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="SUPPLIERS · CONTRACTS" title="Contracts" description="Commercial terms, cancellation policy schedules and policy simulator per supplier contract." />
      {error && <p role="alert">Contracts are unavailable. Please reload to retry.</p>}
      {loading && <p role="status">Loading contracts…</p>}
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search contracts…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(c) => c.id} onRowClick={setSelected} emptyTitle={loading ? "Loading contracts" : error ? "Contracts unavailable" : "No contracts found"} />
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} title={selected?.code ?? ''} subtitle={selected?.supplier.displayName}>
        {selected && (<>
          <DrawerField label="Validity" value={`${selected.validFrom.slice(0, 10)} → ${selected.validTo.slice(0, 10)}`} />
          <DrawerField label="Currency" value={selected.settlementCurrency} />
          <DrawerField label="Status" value={<span>{selected.status}</span>} />

          <div style={{ marginTop: 18, borderTop: '1px solid #d9e2e5', paddingTop: 14, display: 'grid', gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Cancellation Policy Windows</h3>
            {policiesLoading && <p role="status">Loading cancellation policies…</p>}
            {policies && policies.cancellationPolicies.length === 0 && (
              <p style={{ color: '#698088', fontSize: 12 }}>No cancellation windows configured. Missing policy data fails closed (`UNRESOLVED`) and is never treated as free cancellation.</p>
            )}
            {policies && policies.cancellationPolicies.map(rule => (
              <div key={rule.id} style={{ fontSize: 12, padding: '8px 10px', background: '#f5f8f9', borderRadius: 6 }}>
                <strong>{rule.daysBeforeCheckin}d before check-in:</strong>{' '}
                {rule.penaltyPercent !== null
                  ? `${rule.penaltyPercent}% penalty`
                  : formatMinorUnits(rule.penaltyMinor ?? '0', rule.currency ?? selected.settlementCurrency)}
              </div>
            ))}

            <div style={{ display: 'grid', gap: 8, paddingTop: 6 }}>
              <label style={{ fontSize: 12 }}>
                Days before check-in
                <input aria-label="Days before check-in" value={daysBeforeCheckin} onChange={e => setDaysBeforeCheckin(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: 12 }}>
                Penalty type
                <select aria-label="Penalty type" value={penaltyMode} onChange={e => setPenaltyMode(e.target.value as 'PERCENTAGE' | 'FIXED')} className="admin-filter-select" style={{ width: '100%' }}>
                  <option value="PERCENTAGE">PERCENTAGE (%)</option>
                  <option value="FIXED">FIXED ({selected.settlementCurrency})</option>
                </select>
              </label>
              <label style={{ fontSize: 12 }}>
                {penaltyMode === 'PERCENTAGE' ? 'Penalty percent (0–100)' : `Fixed amount (${selected.settlementCurrency})`}
                <input aria-label="Penalty value" value={penaltyValue} onChange={e => setPenaltyValue(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
              </label>
              <button type="button" onClick={addCancellationWindow} className="admin-button-primary">Add Cancellation Window</button>
              {policyMessage && <p role="status" style={{ fontSize: 12 }}>{policyMessage}</p>}
            </div>
          </div>

          <div style={{ marginTop: 18, borderTop: '1px solid #d9e2e5', paddingTop: 14, display: 'grid', gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Cancellation Policy Simulator</h3>
            <label style={{ fontSize: 12 }}>
              Policy classification
              <select aria-label="Policy classification" value={simPolicyType} onChange={e => setSimPolicyType(e.target.value as 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL')} className="admin-filter-select" style={{ width: '100%' }}>
                <option value="REFUNDABLE">REFUNDABLE</option>
                <option value="NON_REFUNDABLE">NON_REFUNDABLE</option>
                <option value="CONDITIONAL">CONDITIONAL</option>
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              Deadline semantics
              <select aria-label="Deadline semantics" value={simSemantics} onChange={e => setSimSemantics(e.target.value as 'CALENDAR_DAYS_AT_LOCAL_TIME' | 'ELAPSED_HOURS')} className="admin-filter-select" style={{ width: '100%' }}>
                <option value="CALENDAR_DAYS_AT_LOCAL_TIME">Calendar days at hotel local check-in time</option>
                <option value="ELAPSED_HOURS">Elapsed hours before check-in</option>
              </select>
            </label>
            <label style={{ fontSize: 12 }}>
              Check-in date
              <input aria-label="Simulation check-in date" type="date" value={simCheckIn} onChange={e => setSimCheckIn(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Hotel IANA timezone &amp; local check-in time
              <div style={{ display: 'flex', gap: 8 }}>
                <input aria-label="Hotel IANA timezone" value={simTimeZone} onChange={e => setSimTimeZone(e.target.value)} className="admin-filter-select" style={{ flex: 1 }} />
                <input aria-label="Check-in local time" value={simLocalTime} onChange={e => setSimLocalTime(e.target.value)} className="admin-filter-select" style={{ width: 90 }} />
              </div>
            </label>
            <label style={{ fontSize: 12 }}>
              Cancellation timestamp (ISO-8601 UTC)
              <input aria-label="Cancellation timestamp" value={simRequestedAt} onChange={e => setSimRequestedAt(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Stay amount ({selected.settlementCurrency})
              <input aria-label="Stay amount" value={simAmount} onChange={e => setSimAmount(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Nightly prices CSV (optional, e.g. 250.00, 300.00, 450.00)
              <input aria-label="Nightly prices CSV" value={simNightlyCsv} onChange={e => setSimNightlyCsv(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
            </label>
            <label style={{ fontSize: 12 }}>
              Customer amount paid / Retained fees / Prior refunds ({selected.settlementCurrency})
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                <input aria-label="Customer amount paid" placeholder="Paid" value={simPaidAmount} onChange={e => setSimPaidAmount(e.target.value)} className="admin-filter-select" />
                <input aria-label="Retained fees" placeholder="Fees" value={simRetainedFees} onChange={e => setSimRetainedFees(e.target.value)} className="admin-filter-select" />
                <input aria-label="Prior refunds" placeholder="Prior refund" value={simPriorRefunds} onChange={e => setSimPriorRefunds(e.target.value)} className="admin-filter-select" />
              </div>
            </label>
            <button type="button" onClick={runSimulation} className="admin-button-secondary">Simulate Cancellation</button>
            {simError && <p role="alert" style={{ fontSize: 12 }}>{simError}</p>}
            {simResult && (
              <div style={{ fontSize: 12, padding: 12, background: '#f5f8f9', borderRadius: 6, display: 'grid', gap: 6 }}>
                <div><strong>Resolution:</strong> {simResult.policyResolution} ({simResult.status}{simResult.reason ? ` · ${simResult.reason}` : ''})</div>
                <div><strong>Free-cancellation deadline (UTC):</strong> {simResult.freeCancellationDeadlineUtc ?? 'None'}</div>
                <div><strong>Selected window deadline (UTC):</strong> {simResult.selectedWindowDeadlineUtc ?? 'None (before penalty window)'}</div>
                <div><strong>Selected penalty type:</strong> {simResult.selectedPenaltyType ?? '—'}</div>
                <div><strong>Accommodation penalty:</strong> {formatMinorUnits(simResult.penaltyMinor, simResult.currency)}</div>
                <div><strong>Customer cancellation liability:</strong> {formatMinorUnits(simResult.customerCancellationLiabilityMinor, simResult.currency)}</div>
                <div><strong>Customer refund payable:</strong> {formatMinorUnits(simResult.customerRefundPayableMinor, simResult.currency)}</div>
                <div><strong>Settlement balance:</strong> {formatMinorUnits(simResult.settlementBalanceMinor, simResult.currency)}</div>
                <div><strong>Supplier penalty / Expected credit:</strong> {formatMinorUnits(simResult.supplierPenaltyMinor, simResult.currency)} / {formatMinorUnits(simResult.supplierExpectedCreditMinor, simResult.currency)}</div>
                {simResult.discrepancyReviewRequired && (
                  <div role="alert" style={{ color: '#9e2a2b', fontWeight: 600 }}>Discrepancy review required: supplier penalty exceeds customer liability.</div>
                )}
              </div>
            )}
          </div>
        </>)}
      </DetailDrawer>
    </div>
  )
}
