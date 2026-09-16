import { ForbiddenException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'

@Injectable()
export class AgentFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId }, include: { entries: { orderBy: { immutableAt: 'desc' }, take: 25 } } })
    if (!wallet) return { status: 'not_configured' as const, currency: 'USD', availableCredit: null, ledger: [] }
    return { status: 'active' as const, currency: wallet.currency, availableCredit: wallet.creditLimit + wallet.balance, balance: wallet.balance, creditLimit: wallet.creditLimit, ledger: wallet.entries }
  }

  async assertFunds(tenantId: string, totalMinor: number) {
    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId } })
    if (!wallet || wallet.creditLimit + wallet.balance < totalMinor) throw new ForbiddenException('Insufficient tenant credit')
    return wallet
  }
}
