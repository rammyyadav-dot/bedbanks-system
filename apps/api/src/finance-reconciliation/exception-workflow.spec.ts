import { allowedActions, approve, propose, reject, secondApprovalByAction, type WorkflowSubject } from './exception-workflow'

const subject = (over: Partial<WorkflowSubject> = {}): WorkflowSubject => ({
  status: 'OPEN', type: 'AMOUNT_OVERCHARGE', currency: 'AED', statementMinor: 12500n, ledgerMinor: 12000n, varianceMinor: 500n, proposedAction: null, proposedById: null, ...over,
})

describe('exception workflow', () => {
  it('a small accept resolves at once with the maker as resolver and no second person', () => {
    expect(propose(subject(), 'ACCEPT_STATEMENT', 'u1')).toMatchObject({ kind: 'ok', to: 'RESOLVED', resolution: 'ACCEPT_STATEMENT', resolvedById: 'u1', secondApprovalRequired: false })
  })

  it('an amount at the threshold waits for a different person; the proposer can neither approve nor reject', () => {
    const big = subject({ statementMinor: 22000n, varianceMinor: 10000n })
    const pending = propose(big, 'ACCEPT_STATEMENT', 'u1')
    expect(pending).toMatchObject({ kind: 'ok', to: 'PENDING_APPROVAL', secondApprovalRequired: true, resolution: null, resolvedById: null })
    const waiting = subject({ ...big, status: 'PENDING_APPROVAL', proposedAction: 'ACCEPT_STATEMENT', proposedById: 'u1' })
    expect(approve(waiting, 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_SEPARATION_OF_DUTIES', status: 403 })
    expect(reject(waiting, 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_SEPARATION_OF_DUTIES' })
    expect(approve(waiting, 'u2')).toMatchObject({ kind: 'ok', to: 'RESOLVED', resolution: 'ACCEPT_STATEMENT', resolvedById: 'u2', proposedById: 'u1' })
    expect(reject(waiting, 'u2')).toMatchObject({ kind: 'ok', to: 'OPEN', proposedAction: null, proposedById: null })
  })

  it('disputing and acknowledging need no second person at any amount; a dispute parks the exception and cannot be repeated', () => {
    const big = subject({ statementMinor: 9_000_000n, varianceMinor: 8_988_000n })
    expect(propose(big, 'KEEP_LEDGER_AND_DISPUTE', 'u1')).toMatchObject({ kind: 'ok', to: 'DISPUTED', secondApprovalRequired: false, resolution: null })
    expect(propose({ ...big, status: 'DISPUTED' }, 'KEEP_LEDGER_AND_DISPUTE', 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_ALREADY_DISPUTED' })
    expect(propose(subject({ type: 'MISSING_FROM_STATEMENT', statementMinor: null, varianceMinor: null }), 'ACKNOWLEDGE', 'u1')).toMatchObject({ kind: 'ok', to: 'RESOLVED' })
  })

  it('a disputed exception can still be accepted or rejected later', () => {
    expect(propose(subject({ status: 'DISPUTED' }), 'ACCEPT_STATEMENT', 'u1')).toMatchObject({ kind: 'ok', to: 'RESOLVED' })
  })

  it('an unknown amount always needs a second person', () => {
    const unknown = subject({ type: 'UNMATCHED_LINE', statementMinor: null, ledgerMinor: null, varianceMinor: null })
    expect(propose(unknown, 'REJECT_STATEMENT_LINE', 'u1')).toMatchObject({ kind: 'ok', to: 'PENDING_APPROVAL' })
  })

  it('refuses an action the exception type does not offer, a write-off without a computed variance, and any move on a closed or pending item', () => {
    expect(propose(subject({ type: 'ROUNDING_VARIANCE' }), 'REJECT_STATEMENT_LINE', 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_ACTION_NOT_ALLOWED', status: 422 })
    expect(propose(subject({ type: 'ROUNDING_VARIANCE', varianceMinor: null }), 'WRITE_OFF_VARIANCE', 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_ACTION_NOT_ALLOWED' })
    expect(propose(subject({ status: 'RESOLVED' }), 'ACCEPT_STATEMENT', 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_ALREADY_RESOLVED' })
    expect(propose(subject({ status: 'PENDING_APPROVAL' }), 'ACCEPT_STATEMENT', 'u1')).toMatchObject({ kind: 'refused', code: 'RECON_DECISION_PENDING' })
    expect(approve(subject(), 'u2')).toMatchObject({ kind: 'refused', code: 'RECON_NOTHING_PENDING' })
    expect(reject(subject({ status: 'DISPUTED' }), 'u2')).toMatchObject({ kind: 'refused', code: 'RECON_NOTHING_PENDING' })
  })

  it('clean matches offer no action; the per-action approval map covers exactly the allowed actions', () => {
    expect(allowedActions('MATCHED', 0n)).toEqual([])
    expect(allowedActions('CREDIT_MATCHED', 0n)).toEqual([])
    const map = secondApprovalByAction(subject())
    expect(Object.keys(map).sort()).toEqual([...allowedActions('AMOUNT_OVERCHARGE', 500n)].sort())
    expect(map).toEqual({ KEEP_LEDGER_AND_DISPUTE: false, ACCEPT_STATEMENT: false, REJECT_STATEMENT_LINE: true })
  })
})
