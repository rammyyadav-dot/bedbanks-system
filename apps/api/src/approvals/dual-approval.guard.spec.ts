import 'reflect-metadata'
import { ForbiddenException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { DualApprovalGuard, RequireDualApproval, RequireStepUp, StepUpGuard } from './dual-approval.guard'
import type { ApprovalView } from './approval.service'

class Routes {
  @RequireStepUp('markup.activate') decide() { /* metadata carrier */ }
  @RequireStepUp('finance.settle.approve', 'settlementId') settle() { /* metadata carrier */ }
  @RequireDualApproval('markup.activate') execute() { /* metadata carrier */ }
  undecorated() { /* no metadata */ }
}
const ctx = (handler: () => void, req: Record<string, unknown>) => ({ getHandler: () => handler, getClass: () => Routes, switchToHttp: () => ({ getRequest: () => req }) }) as never
const base = (extra: Record<string, unknown> = {}) => ({ user: { user: { id: 'checker' } }, activeTenantId: 't1', params: { approvalId: 'a1' }, body: {}, ...extra })

describe('StepUpGuard', () => {
  const make = () => { const calls: any[] = []; const guard = new StepUpGuard(new Reflector(), { verify: async (i: unknown) => { calls.push(i) } } as never); return { guard, calls } }

  it('verifies the password for the session user and tenant, then removes it from the body', async () => {
    const { guard, calls } = make()
    const req = base({ body: { reason: 'ok', stepUpPassword: 'secret-pw' } })
    await expect(guard.canActivate(ctx(Routes.prototype.decide, req))).resolves.toBe(true)
    expect(calls).toEqual([{ tenantId: 't1', userId: 'checker', password: 'secret-pw', action: 'markup.activate', entityId: 'a1' }])
    expect(req.body).toEqual({ reason: 'ok' })
  })

  it('takes identity from the session, never from the body', async () => {
    const { guard, calls } = make()
    await guard.canActivate(ctx(Routes.prototype.decide, base({ body: { userId: 'attacker', tenantId: 'other', stepUpPassword: 'pw' } })))
    expect(calls[0]).toMatchObject({ tenantId: 't1', userId: 'checker' })
  })

  it('uses the route parameter the decorator names', async () => {
    const { guard, calls } = make()
    await guard.canActivate(ctx(Routes.prototype.settle, base({ params: { settlementId: 's9' } })))
    expect(calls[0].entityId).toBe('s9')
  })

  it('removes the password from the body even when verification fails', async () => {
    const guard = new StepUpGuard(new Reflector(), { verify: async () => { throw new ForbiddenException() } } as never)
    const req = base({ body: { stepUpPassword: 'wrong' } })
    await expect(guard.canActivate(ctx(Routes.prototype.decide, req))).rejects.toBeInstanceOf(ForbiddenException)
    expect(req.body).toEqual({})
  })

  it.each([['no session user', { user: undefined }], ['no tenant context', { activeTenantId: undefined }]])('fails closed with %s', async (_n, over) => {
    const { guard, calls } = make()
    await expect(guard.canActivate(ctx(Routes.prototype.decide, base(over)))).rejects.toBeInstanceOf(ForbiddenException)
    expect(calls).toEqual([])
  })

  it('denies a route that forgot its decorator', async () => {
    await expect(make().guard.canActivate(ctx(Routes.prototype.undecorated, base()))).rejects.toBeInstanceOf(ForbiddenException)
  })
})

describe('DualApprovalGuard', () => {
  const approval = (over: Partial<ApprovalView> = {}): ApprovalView => ({ id: 'a1', tenantId: 't1', action: 'markup.activate', entityType: 'markup_rule', entityId: 'r1', requestId: 'q', status: 'APPROVED', requestedById: 'maker', reason: 'r', beforeState: null, proposedState: null, decidedById: 'checker', decidedAt: new Date(), decisionReason: 'ok', executedById: null, executedAt: null, createdAt: new Date(), ...over })
  const make = (a: ApprovalView) => {
    const audits: any[] = []
    const guard = new DualApprovalGuard(new Reflector(), { get: async () => a } as never, { record: async (e: unknown) => { audits.push(e) } } as never)
    return { guard, audits }
  }

  it('passes an approved request for the right action decided by someone else', async () => {
    const { guard, audits } = make(approval())
    await expect(guard.canActivate(ctx(Routes.prototype.execute, base()))).resolves.toBe(true)
    expect(audits).toEqual([])
  })

  it.each([
    ['still pending', { status: 'PENDING' as const, decidedById: null }, 'NOT_APPROVED_PENDING'],
    ['rejected', { status: 'REJECTED' as const }, 'NOT_APPROVED_REJECTED'],
    ['expired', { status: 'EXPIRED' as const }, 'NOT_APPROVED_EXPIRED'],
    ['already executed', { status: 'EXECUTED' as const }, 'NOT_APPROVED_EXECUTED'],
    ['approved for another action', { action: 'fx.activate' }, 'ACTION_MISMATCH'],
    ['approved by its own maker', { decidedById: 'maker' }, 'NO_INDEPENDENT_APPROVER'],
  ])('refuses a direct call when the request is %s, and audits Admin A and Admin B', async (_n, over, reason) => {
    const { guard, audits } = make(approval(over))
    await expect(guard.canActivate(ctx(Routes.prototype.execute, base()))).rejects.toMatchObject({ response: { code: 'DUAL_APPROVAL_REQUIRED', reason } })
    expect(audits[0]).toMatchObject({ action: 'approval.bypass_refused', userId: 'checker', payload: { reason, requestedById: 'maker' } })
  })

  it.each([['no approval id', { params: {} }], ['no session', { user: undefined }]])('fails closed with %s', async (_n, over) => {
    await expect(make(approval()).guard.canActivate(ctx(Routes.prototype.execute, base(over)))).rejects.toBeInstanceOf(ForbiddenException)
  })
})
