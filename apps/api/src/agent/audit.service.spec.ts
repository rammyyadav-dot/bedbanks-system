import { runWithRequestContext } from '../common/request-context'
import { AgentAuditService } from './audit.service'

function make() {
  const created: Array<{ data: { payload: Record<string, unknown>; actorType: string } }> = []
  const tx = { auditEvent: { create: async (a: (typeof created)[number]) => { created.push(a); return a } } }
  const prisma = { withTenant: async (_t: string, fn: (t: unknown) => unknown) => fn(tx), auditEvent: tx.auditEvent }
  return { service: new AgentAuditService(prisma as never), created }
}

describe('AgentAuditService request context', () => {
  it('stamps the caller address and request id on events written during a request', async () => {
    const { service, created } = make()
    await runWithRequestContext({ requestId: 'rid-12345678', ip: '198.51.100.7' }, () => service.record({ tenantId: 't1', userId: 'u1', action: 'x', entityType: 'e', entityId: '1', payload: { a: 1 } }))
    expect(created[0].data.payload).toEqual({ ip: '198.51.100.7', requestId: 'rid-12345678', a: 1 })
  })

  it('writes events outside a request (workers, sweepers) unchanged', async () => {
    const { service, created } = make()
    await service.record({ tenantId: 't1', action: 'x', entityType: 'e', entityId: '1', payload: { a: 1 } })
    expect(created[0].data.payload).toEqual({ a: 1 })
  })

  it('lets an explicit payload field win over the context', async () => {
    const { service, created } = make()
    await runWithRequestContext({ requestId: 'rid-12345678', ip: '198.51.100.7' }, () => service.record({ tenantId: 't1', action: 'x', entityType: 'e', entityId: '1', payload: { ip: 'declared' } }))
    expect(created[0].data.payload.ip).toBe('declared')
  })
})
