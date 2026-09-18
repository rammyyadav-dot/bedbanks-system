import { ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'

@Injectable()
export class AgentFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string) {
    const wallet = await this.prisma.withTenant(tenantId, (tx) => tx.wallet.findFirst({ where: { tenantId, currency: 'USD' }, include: { entries: { orderBy: { immutableAt: 'desc' }, take: 25 } } }))
    if (!wallet) return { status: 'not_configured' as const, currency: 'USD', availableCredit: null, ledger: [] }
    const balance = wallet.entries.reduce((total, entry) => total + entry.amountMinor, 0n)
    return {
      status: 'active' as const,
      currency: wallet.currency,
      availableCredit: (wallet.creditLimit + balance).toString(),
      balance: balance.toString(),
      creditLimit: wallet.creditLimit.toString(),
      ledger: wallet.entries.map((entry) => ({ ...entry, amountMinor: entry.amountMinor.toString() })),
    }
  }

  async assertFunds(tenantId: string, totalMinor: number | bigint, currency = 'USD') {
    const required = BigInt(totalMinor)
    const wallet = await this.prisma.withTenant(tenantId, async (tx) => {
      const candidate = await tx.wallet.findFirst({ where: { tenantId, currency }, include: { entries: true } })
      if (!candidate) return null
      const balance = candidate.entries.reduce((sum, entry) => sum + entry.amountMinor, 0n)
      return { ...candidate, availableCredit: candidate.creditLimit + balance }
    })
    if (!wallet || wallet.availableCredit < required) throw new ForbiddenException('Insufficient tenant credit')
    return wallet
  }
}
