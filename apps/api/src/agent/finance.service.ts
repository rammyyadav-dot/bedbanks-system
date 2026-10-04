import { ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency, defaultSettlementCurrency } from './currency'

const PREFERRED_CURRENCY = 'AED'

@Injectable()
export class AgentFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Wallet summary for the agent portal. Settlement is AED for the Dubai MVP, so the AED wallet is preferred; a tenant
   * with only another currency sees that wallet, never a made-up zero. The balance is the sum of EVERY ledger entry
   * (a database aggregate); the ledger list is only the latest 25 for display. Until ADR 0028 slice 3 moves holds to agency
   * accounts, the agent portal reads the tenant HOUSE account (agencyId null) that the booking path posts to.
   */
  async summary(tenantId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const wallets = await tx.wallet.findMany({ where: { tenantId, agencyId: null }, orderBy: { currency: 'asc' } })
      const wallet = wallets.find((candidate) => candidate.currency === PREFERRED_CURRENCY) ?? wallets[0]
      if (!wallet) return { status: 'not_configured' as const, currency: PREFERRED_CURRENCY, availableCredit: null, ledger: [] }
      const [aggregate, entries] = await Promise.all([
        tx.ledgerEntry.aggregate({ where: { tenantId, walletId: wallet.id }, _sum: { amountMinor: true } }),
        tx.ledgerEntry.findMany({ where: { tenantId, walletId: wallet.id }, orderBy: { immutableAt: 'desc' }, take: 25 }),
      ])
      const balance = aggregate._sum.amountMinor ?? 0n
      return {
        status: 'active' as const,
        currency: wallet.currency,
        availableCredit: (wallet.creditLimit + balance).toString(),
        balance: balance.toString(),
        creditLimit: wallet.creditLimit.toString(),
        ledger: entries.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString() })),
      }
    })
  }

  async assertFunds(tenantId: string, totalMinor: number | bigint, currency: string = defaultSettlementCurrency()) {
    assertSupportedSettlementCurrency(currency)
    const required = BigInt(totalMinor)
    const wallet = await this.prisma.withTenant(tenantId, async (tx) => {
      const candidate = await tx.wallet.findFirst({ where: { tenantId, agencyId: null, currency }, include: { entries: { where: { tenantId } } } })
      if (!candidate) return null
      const balance = candidate.entries.reduce((sum, entry) => sum + entry.amountMinor, 0n)
      return { ...candidate, availableCredit: candidate.creditLimit + balance }
    })
    if (!wallet || wallet.availableCredit < required) throw new ForbiddenException('Insufficient tenant credit')
    return wallet
  }
}
