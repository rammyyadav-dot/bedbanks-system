import { ForbiddenException, HttpException } from '@nestjs/common'
import { hashPassword } from '../auth/utils/password'
import { runWithRequestContext } from '../common/request-context'
import { StepUpService } from './step-up.service'

const PASSWORD = 'correct horse battery staple 42!'

async function setup(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE', passwordHash: string | null = null) {
  const hash = passwordHash ?? await hashPassword(PASSWORD)
  const audits: Array<{ action: string; userId?: string; entityId: string; payload: Record<string, unknown> }> = []
  const prisma = { user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'u1' ? { id: 'u1', status, passwordHash: hash } : null) } }
  const audit = { record: async (e: (typeof audits)[number]) => { audits.push(e) } }
  const service = new StepUpService(prisma as never, audit as never)
  const verify = (password: unknown, userId = 'u1') => runWithRequestContext({ requestId: 'rid-12345678', ip: '203.0.113.9' }, () => service.verify({ tenantId: 't1', userId, password, action: 'markup.activate', entityId: 'a1' }))
  return { verify, audits }
}

describe('StepUpService', () => {
  it('accepts the signed-in user\'s password and audits the success', async () => {
    const { verify, audits } = await setup()
    await expect(verify(PASSWORD)).resolves.toBeUndefined()
    expect(audits).toEqual([expect.objectContaining({ action: 'step_up.verified', userId: 'u1', entityId: 'a1', payload: { approvalAction: 'markup.activate' } })])
  })

  it.each([[undefined], [''], [123], [{}], ['x'.repeat(257)]])('refuses a missing or malformed password (%p) as STEP_UP_REQUIRED', async (value) => {
    const { verify, audits } = await setup()
    await expect(verify(value)).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } })
    expect(audits.map((a) => a.action)).toEqual(['step_up.missing'])
  })

  it('refuses a wrong password, audits it, and never writes the password anywhere', async () => {
    const { verify, audits } = await setup()
    await expect(verify('not the password')).rejects.toMatchObject({ response: { code: 'STEP_UP_FAILED' } })
    expect(audits.map((a) => a.action)).toEqual(['step_up.failed'])
    expect(JSON.stringify(audits)).not.toContain('not the password')
  })

  it('refuses a suspended user and a user with no password even if the comparison would match', async () => {
    await expect((await setup('SUSPENDED')).verify(PASSWORD)).rejects.toBeInstanceOf(ForbiddenException)
    const noPassword = await setup('ACTIVE', '')
    await expect(noPassword.verify(PASSWORD)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('refuses an unknown user', async () => {
    const { verify } = await setup()
    await expect(verify(PASSWORD, 'ghost')).rejects.toMatchObject({ response: { code: 'STEP_UP_FAILED' } })
  })

  it('throttles after repeated failures, even for the right password, and says so in the audit log', async () => {
    const { verify, audits } = await setup()
    for (let i = 0; i < 5; i++) await expect(verify('wrong')).rejects.toBeInstanceOf(ForbiddenException)
    const blocked = await verify(PASSWORD).catch((e: HttpException) => e)
    expect((blocked as HttpException).getStatus()).toBe(429)
    expect(audits[audits.length - 1].action).toBe('step_up.throttled')
  })
})
