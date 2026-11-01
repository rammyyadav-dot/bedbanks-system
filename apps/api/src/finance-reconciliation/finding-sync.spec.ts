import type { Finding } from '@bedbanks/money'
import { planSync, type StoredFinding } from './finding-sync'

const finding = (over: Partial<Finding> = {}): Finding => ({ key: 'l1', type: 'AMOUNT_OVERCHARGE', rule: 'REFERENCE_ONLY', lineId: 'l1', bookingId: 'b1', currency: 'AED', statementMinor: 12500n, ledgerMinor: 12000n, varianceMinor: 500n, ...over })
const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({ id: 'f1', findingKey: 'l1', status: 'OPEN', isException: true, type: 'AMOUNT_OVERCHARGE', bookingId: 'b1', currency: 'AED', statementMinor: 12500n, ledgerMinor: 12000n, varianceMinor: 500n, ...over })

describe('planSync', () => {
  it('creates findings that do not exist yet', () => {
    expect(planSync([], [finding()])).toEqual([{ op: 'create', finding: finding() }])
  })

  it('keeps unchanged findings in every workflow state, so a re-run never discards a dispute or a pending decision', () => {
    for (const status of ['OPEN', 'DISPUTED', 'PENDING_APPROVAL', 'RESOLVED'] as const) {
      expect(planSync([stored({ status })], [finding()])).toEqual([{ op: 'keep', id: 'f1' }])
    }
  })

  it('never touches a resolved finding, even when the facts differ', () => {
    expect(planSync([stored({ status: 'RESOLVED' })], [finding({ statementMinor: 1n, varianceMinor: -11999n })])).toEqual([{ op: 'keep', id: 'f1' }])
  })

  it('refreshes changed facts; a decision pending a second person is reopened, a dispute stays', () => {
    const changed = finding({ statementMinor: 12400n, varianceMinor: 400n })
    expect(planSync([stored()], [changed])).toEqual([{ op: 'refresh', id: 'f1', finding: changed, reopen: false, autoResolve: false }])
    expect(planSync([stored({ status: 'PENDING_APPROVAL' })], [changed])).toEqual([{ op: 'refresh', id: 'f1', finding: changed, reopen: true, autoResolve: false }])
    expect(planSync([stored({ status: 'DISPUTED' })], [changed])).toEqual([{ op: 'refresh', id: 'f1', finding: changed, reopen: false, autoResolve: false }])
  })

  it('a difference that disappears closes itself', () => {
    const matched = finding({ type: 'MATCHED', rule: 'REFERENCE_AND_NET_EXACT', statementMinor: 12000n, varianceMinor: 0n })
    expect(planSync([stored({ status: 'DISPUTED' })], [matched])).toEqual([{ op: 'refresh', id: 'f1', finding: matched, reopen: false, autoResolve: true }])
  })

  it('a finding no longer produced closes itself unless it is already resolved or was a clean match', () => {
    expect(planSync([stored()], [])).toEqual([{ op: 'autoResolve', id: 'f1' }])
    expect(planSync([stored({ status: 'RESOLVED' })], [])).toEqual([{ op: 'keep', id: 'f1' }])
    expect(planSync([stored({ isException: false, type: 'MATCHED', status: 'RESOLVED' })], [])).toEqual([{ op: 'keep', id: 'f1' }])
  })
})
