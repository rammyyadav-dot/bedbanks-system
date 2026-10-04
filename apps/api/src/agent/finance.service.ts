import { ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { assertSupportedSettlementCurrency, defaultSettlementCurrency } from './currency'
import { agencyPosition } from './agency-account'

const PREFERRED_CURRENCY = 'AED'

@Injectable()
export class AgentFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Wallet summary for the agent portal. Settlement is AED for the Dubai MVP, so the AED wallet is preferred; a tenant
   * with only another currency sees that wallet, never a made-up zero. The balance is the sum of EVERY ledger entry
   * (a database aggregate); the ledger list is only the latest 25 for display.
   *
   * ADR 0028 slice 3: a user who belongs to an agency sees THEIR AGENCY's account, the one their bookings are charged to: available =
   * balance + credit line - pending holds (never below zero), creditLimit = the credit line. Anyone else sees the tenant HOUSE account.
   */
  async summary(tenantId: string, userId?: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const member = userId ? await tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } }) : null
      if (member) {
        const limit = await tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId: member.agencyId }, select: { currency: true } })
        const position = await agencyPosition(tx, tenantId, member.agencyId, limit?.currency ?? defaultSettlementCurrency())
        const entries = position.accountId ? await tx.ledgerEntry.findMany({ where: { tenantId, walletId: position.accountId }, orderBy: { immutableAt: 'desc' }, take: 25 }) : []
        return {
          status: 'active' as const, scope: 'agency' as const, currency: position.currency,
          availableCredit: (position.availableMinor > 0n ? position.availableMinor : 0n).toString(),
          balance: position.balanceMinor.toString(), creditLimit: position.creditLineMinor.toString(), pendingHolds: position.pendingMinor.toString(),
          ledger: entries.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString() })),
        }
      }
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
