import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { assertAgencyCredit } from './agency-credit'

type Fake = { member?: unknown; limit?: unknown; sum?: bigint | null; throwOn?: 'member' | 'limit' | 'sum' }
function tx(f: Fake): Prisma.TransactionClient {
  const boom = (where: string) => { if (f.throwOn === where) { const e = new Error('permission denied') as Error & { code: string }; e.code = '42501'; throw e } }
  return {
    agencyMember: { findFirst: async () => { boom('member'); return f.member ?? null }, findMany: async () => [{ userId: 'u1' }] },
    $executeRaw: async () => 1,
    agencyCreditLimit: { findFirst: async () => { boom('limit'); return f.limit ?? null } },
    inventoryHold: { aggregate: async () => { boom('sum'); return { _sum: { sellAmountMinor: f.sum ?? null } } } },
  } as unknown as Prisma.TransactionClient
}
const limit = (limitMinor: bigint, currency = 'AED') => ({ currency, limitMinor })
const run = (f: Fake, amount = 100n, currency = 'AED') => assertAgencyCredit(tx(f), 't', 'u1', currency, amount)
const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return (e as { getResponse: () => { code: string } }).getResponse().code } }

describe('assertAgencyCredit (ADR 0024)', () => {
  it('does not limit a user in no agency or an agency with no limit', async () => {
    await expect(run({})).resolves.toBeUndefined()
    await expect(run({ member: { agencyId: 'a' } })).resolves.toBeUndefined()
  })
  it('allows up to and including the limit and refuses one minor unit over', async () => {
    await expect(run({ member: { agencyId: 'a' }, limit: limit(1000n), sum: 900n })).resolves.toBeUndefined()
    await expect(run({ member: { agencyId: 'a' }, limit: limit(1000n), sum: 901n })).rejects.toBeInstanceOf(ForbiddenException)
    expect(await code(run({ member: { agencyId: 'a' }, limit: limit(1000n), sum: 901n }))).toBe('AGENCY_CREDIT_LIMIT_EXCEEDED')
  })
  it('refuses a currency other than the limit currency without converting', async () => {
    expect(await code(run({ member: { agencyId: 'a' }, limit: limit(1000n, 'AED') }, 1n, 'USD'))).toBe('AGENCY_CREDIT_CURRENCY_MISMATCH')
  })
  it('fails closed when any read fails, instead of ignoring the limit', async () => {
    for (const throwOn of ['member', 'limit', 'sum'] as const) {
      const p = run({ member: { agencyId: 'a' }, limit: limit(1000n), throwOn })
      await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(await code(run({ member: { agencyId: 'a' }, limit: limit(1000n), throwOn }))).toBe('AGENCY_CREDIT_UNAVAILABLE')
    }
  })
})
