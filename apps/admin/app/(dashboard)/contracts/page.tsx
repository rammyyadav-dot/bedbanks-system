'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { CancellationPolicySimulationResult, ContractPoliciesRead } from '@bedbanks/contracts'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { DetailDrawer } from '@/components/dialogs/DetailDrawer'
import { ContractMarketValidity } from '@/components/commercial/ContractMarketValidity'
import { useCan } from '@/lib/auth/capabilities'
import {
  getContractPortfolio,
  getContractPolicies,
  createContractCancellationPolicy,
  simulateContractCancellationPolicy,
  type AdminContract,
} from '@/lib/data'
import { buildCancellationPolicyWrite, buildCancellationSimulationPayload } from '@/lib/dubai-operations'
import { formatMinorUnits } from '@/lib/minor-units'

const STATUSES = ['DRAFT', 'REVIEW', 'ACTIVE', 'SUSPENDED', 'EXPIRED'].map((value) => ({ value, label: value }))

/** Search, status filter, sort and pagination all run on the API, plus a quick-inspect Market Validity, Cancellation Policy & Simulator drawer. */
export default function ContractsPage() {
  const can = useCan()
  const canManage = can('supply.contracts.manage')
  const [selectedContract, setSelectedContract] = useState<AdminContract | null>(null)
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

  const openContractDrawer = (contract: AdminContract) => {
    setSelectedContract(contract)
    setPolicies(null)
    setPolicyMessage(null)
    setSimResult(null)
    setSimError(null)
    setPoliciesLoading(true)
    getContractPolicies(contract.id)
      .then((data) => setPolicies(data))
      .catch(() => {
        setPolicies(null)
        setPolicyMessage('Contract policies are unavailable.')
      })
      .finally(() => setPoliciesLoading(false))
  }

  const addCancellationWindow = async () => {
    if (!selectedContract) return
    try {
      const payload = buildCancellationPolicyWrite({
        daysBeforeCheckinValue: daysBeforeCheckin,
        mode: penaltyMode,
        penaltyValue,
        currency: selectedContract.settlementCurrency,
      })
      await createContractCancellationPolicy(selectedContract.id, payload)
      const refreshed = await getContractPolicies(selectedContract.id)
      setPolicies(refreshed)
      setPolicyMessage('Added cancellation policy window.')
    } catch (err) {
      setPolicyMessage(err instanceof Error ? err.message : 'Unable to add cancellation policy window.')
    }
  }

  const runSimulation = async () => {
    if (!selectedContract) return
    try {
      setSimError(null)
      const payload = buildCancellationSimulationPayload({
        checkIn: simCheckIn,
        requestedAt: simRequestedAt,
        currency: selectedContract.settlementCurrency,
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
      const result = await simulateContractCancellationPolicy(selectedContract.id, payload)
      setSimResult(result)
    } catch (err) {
      setSimResult(null)
      setSimError(err instanceof Error ? err.message : 'Simulation failed.')
    }
  }

  return (
    <>
      <OpsListPage<AdminContract>
        eyebrow="COMMERCIAL · CONTRACTS"
        title="Contracts"
        description="Authoritative commercial terms, source market validity profiling, cancellation policy schedules and policy simulator per supplier relationship."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/market-groups" className="admin-btn">Source market groups</Link>
            {canManage ? <Link href="/contracts/new" className="admin-btn admin-btn-primary">New contract</Link> : null}
          </div>
        }
        filters={[
          { key: 'search', label: 'Search', type: 'text', placeholder: 'Code or supplier…' },
          { key: 'status', label: 'Status', type: 'select', options: STATUSES },
        ]}
        load={getContractPortfolio}
        getRowId={(c) => c.id}
        emptyTitle="No contracts"
        emptyDescription="No contract matches these filters. Clear them, or create the first contract to start building rate plans."
        columns={[
          { key: 'code', header: 'Contract', sortKey: 'code', render: (c) => <Link href={`/contracts/${c.id}`} style={{ color: 'var(--c-111111)', fontWeight: 600, textDecoration: 'none' }}>{c.code}</Link> },
          { key: 'supplier', header: 'Supplier', render: (c) => c.supplier.displayName },
          { key: 'validity', header: 'Validity', sortKey: 'validFrom', render: (c) => `${c.validFrom.slice(0, 10)} → ${c.validTo.slice(0, 10)}` },
          { key: 'currency', header: 'Currency', sortKey: 'settlementCurrency', render: (c) => c.settlementCurrency },
          { key: 'mapping', header: 'Hotel binding', render: (c) => (c.supplierHotelMapping ? c.supplierHotelMapping.status : 'Unbound') },
          { key: 'status', header: 'Status', sortKey: 'status', render: (c) => c.status },
          {
            key: 'marketValidity',
            header: 'Source markets',
            render: (c) => (
              <button
                type="button"
                className="admin-btn"
                style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={() => openContractDrawer(c)}
                data-testid={`open-market-validity-drawer-${c.code}`}
              >
                Market validity &amp; simulator
              </button>
            ),
          },
        ]}
      />
      <DetailDrawer
        open={selectedContract !== null}
        onClose={() => setSelectedContract(null)}
        title={selectedContract ? `Contract ${selectedContract.code} · Source Market Profiling` : 'Source Market Profiling'}
        subtitle={selectedContract ? `${selectedContract.supplier.displayName} · ${selectedContract.validFrom.slice(0, 10)} → ${selectedContract.validTo.slice(0, 10)}` : undefined}
      >
        {selectedContract ? (
          <>
            <ContractMarketValidity
              contractId={selectedContract.id}
              contractCode={selectedContract.code}
              contractStatus={selectedContract.status}
              canManage={canManage}
            />

            <div style={{ marginTop: 18, borderTop: '1px solid var(--c-e4e4e0)', paddingTop: 14, display: 'grid', gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Cancellation Policy Windows</h3>
              {policiesLoading && <p role="status">Loading cancellation policies…</p>}
              {policies && policies.cancellationPolicies.length === 0 && (
                <p style={{ color: 'var(--c-6b6b6b)', fontSize: 12 }}>No cancellation windows configured. Missing policy data fails closed (`UNRESOLVED`) and is never treated as free cancellation.</p>
              )}
              {policies && policies.cancellationPolicies.map((rule) => (
                <div key={rule.id} style={{ fontSize: 12, padding: '8px 10px', background: 'var(--c-f6f6f4)', borderRadius: 6 }}>
                  <strong>{rule.daysBeforeCheckin}d before check-in:</strong>{' '}
                  {rule.penaltyPercent !== null
                    ? `${rule.penaltyPercent}% penalty`
                    : formatMinorUnits(rule.penaltyMinor ?? '0', rule.currency ?? selectedContract.settlementCurrency)}
                </div>
              ))}

              <div style={{ display: 'grid', gap: 8, paddingTop: 6 }}>
                <label style={{ fontSize: 12 }}>
                  Days before check-in
                  <input aria-label="Days before check-in" value={daysBeforeCheckin} onChange={(e) => setDaysBeforeCheckin(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
                </label>
                <label style={{ fontSize: 12 }}>
                  Penalty type
                  <select aria-label="Penalty type" value={penaltyMode} onChange={(e) => setPenaltyMode(e.target.value as 'PERCENTAGE' | 'FIXED')} className="admin-filter-select" style={{ width: '100%' }}>
                    <option value="PERCENTAGE">PERCENTAGE (%)</option>
                    <option value="FIXED">FIXED ({selectedContract.settlementCurrency})</option>
                  </select>
                </label>
                <label style={{ fontSize: 12 }}>
                  {penaltyMode === 'PERCENTAGE' ? 'Penalty percent (0–100)' : `Fixed amount (${selectedContract.settlementCurrency})`}
                  <input aria-label="Penalty value" value={penaltyValue} onChange={(e) => setPenaltyValue(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
                </label>
                <button type="button" onClick={addCancellationWindow} className="admin-button-primary">Add Cancellation Window</button>
                {policyMessage && <p role="status" style={{ fontSize: 12 }}>{policyMessage}</p>}
              </div>
            </div>

            <div style={{ marginTop: 18, borderTop: '1px solid var(--c-e4e4e0)', paddingTop: 14, display: 'grid', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Cancellation Policy Simulator</h3>
              <label style={{ fontSize: 12 }}>
                Policy classification
                <select aria-label="Policy classification" value={simPolicyType} onChange={(e) => setSimPolicyType(e.target.value as 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL')} className="admin-filter-select" style={{ width: '100%' }}>
                  <option value="REFUNDABLE">REFUNDABLE</option>
                  <option value="NON_REFUNDABLE">NON_REFUNDABLE</option>
                  <option value="CONDITIONAL">CONDITIONAL</option>
                </select>
              </label>
              <label style={{ fontSize: 12 }}>
                Deadline semantics
                <select aria-label="Deadline semantics" value={simSemantics} onChange={(e) => setSimSemantics(e.target.value as 'CALENDAR_DAYS_AT_LOCAL_TIME' | 'ELAPSED_HOURS')} className="admin-filter-select" style={{ width: '100%' }}>
                  <option value="CALENDAR_DAYS_AT_LOCAL_TIME">Calendar days at hotel local check-in time</option>
                  <option value="ELAPSED_HOURS">Elapsed hours before check-in</option>
                </select>
              </label>
              <label style={{ fontSize: 12 }}>
                Check-in date
                <input aria-label="Simulation check-in date" type="date" value={simCheckIn} onChange={(e) => setSimCheckIn(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: 12 }}>
                Hotel IANA timezone &amp; local check-in time
                <div style={{ display: 'flex', gap: 8 }}>
                  <input aria-label="Hotel IANA timezone" value={simTimeZone} onChange={(e) => setSimTimeZone(e.target.value)} className="admin-filter-select" style={{ flex: 1 }} />
                  <input aria-label="Check-in local time" value={simLocalTime} onChange={(e) => setSimLocalTime(e.target.value)} className="admin-filter-select" style={{ width: 90 }} />
                </div>
              </label>
              <label style={{ fontSize: 12 }}>
                Cancellation timestamp (ISO-8601 UTC)
                <input aria-label="Cancellation timestamp" value={simRequestedAt} onChange={(e) => setSimRequestedAt(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: 12 }}>
                Stay amount ({selectedContract.settlementCurrency})
                <input aria-label="Stay amount" value={simAmount} onChange={(e) => setSimAmount(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: 12 }}>
                Nightly prices CSV (optional, e.g. 250.00, 300.00, 450.00)
                <input aria-label="Nightly prices CSV" value={simNightlyCsv} onChange={(e) => setSimNightlyCsv(e.target.value)} className="admin-filter-select" style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: 12 }}>
                Customer amount paid / Retained fees / Prior refunds ({selectedContract.settlementCurrency})
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                  <input aria-label="Customer amount paid" placeholder="Paid" value={simPaidAmount} onChange={(e) => setSimPaidAmount(e.target.value)} className="admin-filter-select" />
                  <input aria-label="Retained fees" placeholder="Fees" value={simRetainedFees} onChange={(e) => setSimRetainedFees(e.target.value)} className="admin-filter-select" />
                  <input aria-label="Prior refunds" placeholder="Prior refund" value={simPriorRefunds} onChange={(e) => setSimPriorRefunds(e.target.value)} className="admin-filter-select" />
                </div>
              </label>
              <button type="button" onClick={runSimulation} className="admin-button-secondary">Simulate Cancellation</button>
              {simError && <p role="alert" style={{ fontSize: 12 }}>{simError}</p>}
              {simResult && (
                <div style={{ fontSize: 12, padding: 12, background: 'var(--c-f6f6f4)', borderRadius: 6, display: 'grid', gap: 6 }}>
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
                    <div role="alert" style={{ color: 'var(--c-b3141b)', fontWeight: 600 }}>Discrepancy review required: supplier penalty exceeds customer liability.</div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : null}
      </DetailDrawer>
    </>
  )
}
