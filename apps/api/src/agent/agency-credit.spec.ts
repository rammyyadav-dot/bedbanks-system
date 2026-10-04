import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { assertAgencyCredit } from './agency-credit'

type Fake = { member?: unknown; limit?: unknown; account?: unknown; balance?: bigint | null; pending?: bigint | null; throwOn?: 'member' | 'limit' | 'pending' | 'ledger' }
function tx(f: Fake): Prisma.TransactionClient {
  const boom = (where: string) => { if (f.throwOn === where) { const e = new Error('permission denied') as Error & { code: string }; e.code = '42501'; throw e } }
  return {
    agencyMember: { findFirst: async () => { boom('member'); return f.member ?? null }, findMany: async () => [{ userId: 'u1' }] },
    $executeRaw: async () => 1,
    wallet: { findFirst: async () => f.account ?? null },
    ledgerEntry: { aggregate: async () => { boom('ledger'); return { _sum: { amountMinor: f.balance ?? null } } } },
    agencyCreditLimit: { findFirst: async () => { boom('limit'); return f.limit ?? null } },
    inventoryHold: { aggregate: async () => { boom('pending'); return { _sum: { sellAmountMinor: f.pending ?? null } } } },
  } as unknown as Prisma.TransactionClient
}
const limit = (limitMinor: bigint, currency = 'AED') => ({ currency, limitMinor })
const member = { agencyId: 'a' }
const account = { id: 'w-a' }
const run = (f: Fake, amount = 100n, currency = 'AED') => assertAgencyCredit(tx(f), 't', 'u1', currency, amount)
const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return (e as { getResponse: () => { code: string } }).getResponse().code } }

describe('assertAgencyCredit (ADR 0028 slice 3: balance + credit line - pending holds)', () => {
  it('does not check a user in no agency here (prebook refuses them)', async () => {
    await expect(run({})).resolves.toBeUndefined()
  })
  it('a prepaid agency (no credit line) can hold up to its balance, not one minor unit more', async () => {
    expect(await code(run({ member }))).toBe('AGENCY_CREDIT_LIMIT_EXCEEDED') // no account, no line: nothing to spend
    await expect(run({ member, account, balance: 1000n, pending: 900n })).resolves.toBeUndefined()
    expect(await code(run({ member, account, balance: 1000n, pending: 901n }))).toBe('AGENCY_CREDIT_LIMIT_EXCEEDED')
  })
  it('balance and credit line add up; a negative balance (credit in use) reduces what is left', async () => {
    await expect(run({ member, account, balance: 500n, limit: limit(500n), pending: 900n })).resolves.toBeUndefined()
    await expect(run({ member, account, balance: -400n, limit: limit(1000n), pending: 500n })).resolves.toBeUndefined()
    await expect(run({ member, account, balance: -400n, limit: limit(1000n), pending: 501n })).rejects.toBeInstanceOf(ForbiddenException)
  })
  it('a credit line in another currency counts as zero, never converted', async () => {
    expect(await code(run({ member, account, balance: 0n, limit: limit(1_000_000n, 'USD') }))).toBe('AGENCY_CREDIT_LIMIT_EXCEEDED')
  })
  it('fails closed when any read fails, instead of ignoring the position', async () => {
    for (const throwOn of ['member', 'limit', 'pending', 'ledger'] as const) {
      const p = run({ member, account, limit: limit(1000n), throwOn })
      await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(await code(run({ member, account, limit: limit(1000n), throwOn }))).toBe('AGENCY_CREDIT_UNAVAILABLE')
    }
  })
})
