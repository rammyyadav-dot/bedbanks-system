import { ForbiddenException, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AGENCY_CREDIT_OVERDUE_CODE, AGENCY_CREDIT_PAUSED_CODE, AGENCY_CREDIT_RISK_POLICY, AGENCY_CREDIT_TERMS, AGENCY_REQUIRED_FOR_BOOKING_CODE, type AgencyOverdueView } from '@bedbanks/contracts'
import { availableMinor, evaluateCreditRisk, type CreditRiskResult } from '@bedbanks/money'
import { walletBalanceMinor } from '../ledger/ledger-core'
import { ageAccount, type Aging } from './credit-aging'

/**
 * One credit concept (ADR 0028 slice 3, owner decision 2026-10-04): an agency's CREDIT LINE is its approved credit limit (ADR 0024
 * maker-checker), in that limit's currency; a credit line in another currency counts as zero, never converted. An agency with no credit
 * line is PREPAID: it can spend its account balance and nothing more. Agency accounts never use `Wallet.credit_limit` (a CHECK keeps it 0).
 *
 *   spendable = account balance (ledger sum) + credit line
 *   pending   = sell amounts of the agency's unexpired holds not yet in the ledger (HOLD_PENDING or HELD; prebook moves a hold to PROCESSING)
 *   available = spendable - pending
 *
 * The binding check is the financial authorization at prebook (wallet row lock, ledger sum). The hold-time check is an early refusal.
 */
const PENDING_STATUSES = ['HOLD_PENDING', 'HELD'] as const

export const accountLockKey = (agencyId: string, currency: string) => `agency-account:${agencyId}:${currency}`

export async function agencyCreditLineMinor(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string): Promise<bigint> {
  const limit = await tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId }, select: { currency: true, limitMinor: true } })
  return limit && limit.currency === currency ? limit.limitMinor : 0n
}

/** The credit line an account may spend against: the agency's for an agency account, the stored limit for the house account. */
export async function accountCreditLineMinor(tx: Prisma.TransactionClient, wallet: { tenantId: string; agencyId: string | null; currency: string; creditLimit: bigint }): Promise<bigint> {
  return wallet.agencyId ? agencyCreditLineMinor(tx, wallet.tenantId, wallet.agencyId, wallet.currency) : wallet.creditLimit
}

/**
 * Credit lines of many accounts in one query, with the same rule as `accountCreditLineMinor`: a house account uses its stored limit; an
 * agency account uses its agency's approved limit in the same currency, else zero (its own `credit_limit` is always 0).
 */
export async function creditLineResolver(tx: Prisma.TransactionClient, tenantId: string, wallets: ReadonlyArray<{ agencyId: string | null }>) {
  const agencyIds = [...new Set(wallets.flatMap(w => (w.agencyId ? [w.agencyId] : [])))]
  const limits = agencyIds.length ? await tx.agencyCreditLimit.findMany({ where: { tenantId, agencyId: { in: agencyIds } }, select: { agencyId: true, currency: true, limitMinor: true } }) : []
  const byAgency = new Map(limits.map(l => [l.agencyId, l]))
  return (w: { agencyId: string | null; currency: string; creditLimit: bigint }): bigint => {
    if (!w.agencyId) return w.creditLimit
    const l = byAgency.get(w.agencyId)
    return l && l.currency === w.currency ? l.limitMinor : 0n
  }
}

export async function agencyPendingMinor(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string, now = new Date()): Promise<bigint> {
  const members = await tx.agencyMember.findMany({ where: { tenantId, agencyId }, select: { userId: true } })
  if (members.length === 0) return 0n
  const sum = await tx.inventoryHold.aggregate({
    _sum: { sellAmountMinor: true },
    where: { tenantId, currency, createdByUserId: { in: members.map(m => m.userId) }, status: { in: [...PENDING_STATUSES] }, expiresAt: { gt: now } },
  })
  return sum._sum.sellAmountMinor ?? 0n
}

export interface AgencyPosition { accountId: string | null; currency: string; balanceMinor: bigint; creditLineMinor: bigint; pendingMinor: bigint; availableMinor: bigint }

export async function agencyPosition(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string): Promise<AgencyPosition> {
  const account = await tx.wallet.findFirst({ where: { tenantId, agencyId, currency }, select: { id: true } })
  const balance = account ? await walletBalanceMinor(tx, tenantId, account.id) : 0n
  const creditLine = await agencyCreditLineMinor(tx, tenantId, agencyId, currency)
  const pending = await agencyPendingMinor(tx, tenantId, agencyId, currency)
  return { accountId: account?.id ?? null, currency, balanceMinor: balance, creditLineMinor: creditLine, pendingMinor: pending, availableMinor: availableMinor({ balanceMinor: balance, creditLineMinor: creditLine, pendingMinor: pending }) }
}

/**
 * The account a booking of this user is charged to: their agency's account in the hold currency, opened if it does not exist yet.
 * Owner decision (2026-10-04): a user who belongs to no agency cannot book; the house account is never charged for a booking.
 */
export async function bookingAccountFor(tx: Prisma.TransactionClient, tenantId: string, userId: string, currency: string): Promise<{ id: string; agencyId: string }> {
  const member = await tx.agencyMember.findFirst({ where: { tenantId, userId }, select: { agencyId: true } })
  if (!member) throw new ForbiddenException({ message: 'Your user is not linked to an agency, so it cannot book. Ask your administrator to add you to your agency.', code: AGENCY_REQUIRED_FOR_BOOKING_CODE })
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountLockKey(member.agencyId, currency)}, 0))`)
  const account = await tx.wallet.findFirst({ where: { tenantId, agencyId: member.agencyId, currency }, select: { id: true } })
    ?? await tx.wallet.create({ data: { tenantId, agencyId: member.agencyId, currency }, select: { id: true } })
  assertNotOverdue(await accountAging(tx, tenantId, account.id))
  await enforceCreditRisk(tx, { tenantId, userId, agencyId: member.agencyId, currency, amountMinor: 0n, scope: 'PREBOOK' })
  return { id: account.id, agencyId: member.agencyId }
}

/** FIFO aging of an account's settled charges (ADR 0028 slice 4). An account with no entries is CURRENT. */
export async function accountAging(tx: Prisma.TransactionClient, tenantId: string, accountId: string | null, now = new Date()): Promise<Aging> {
  if (!accountId) return ageAccount([], now)
  const entries = await tx.ledgerEntry.findMany({
    where: { tenantId, walletId: accountId, type: { in: ['DEBIT', 'CREDIT', 'REFUND', 'ADJUSTMENT', 'REVERSAL'] } },
    orderBy: [{ immutableAt: 'asc' }, { id: 'asc' }], select: { type: true, amountMinor: true, reference: true, immutableAt: true },
  })
  return ageAccount(entries.map(e => ({ type: e.type, amountMinor: e.amountMinor, reference: e.reference, at: e.immutableAt })), now)
}

export const overdueView = (a: Aging): AgencyOverdueView => ({ state: a.state, unpaidMinor: a.unpaidMinor.toString(), oldestUnpaidAt: a.oldestUnpaidAt?.toISOString() ?? null, daysOverdue: a.daysOverdue })

/** Payment terms (owner decision 2026-10-04): from 30 days unpaid, new holds and bookings are refused until the agency pays. */
export function assertNotOverdue(aging: Aging): void {
  if (aging.state !== 'HOLDS_REFUSED') return
  throw new ForbiddenException({
    message: `Your agency has charges unpaid for ${aging.daysOverdue} days. New holds are refused after ${AGENCY_CREDIT_TERMS.refuseHoldsAfterDays} days until a payment is received.`,
    code: AGENCY_CREDIT_OVERDUE_CODE, details: { daysOverdue: aging.daysOverdue, unpaidMinor: aging.unpaidMinor.toString() },
  })
}

/** 'enforce' refuses a paused agency; anything else is 'shadow': the decision is recorded (log and audit event) and nothing is refused. Shadow is the default so a policy change never surprises live agencies. */
export const creditRiskMode = (env: NodeJS.ProcessEnv = process.env): 'enforce' | 'shadow' => (env.CREDIT_RISK_ENFORCEMENT === 'enforce' ? 'enforce' : 'shadow')

/** The risk of one agency account from its live position and aging. Read-only. */
export async function agencyCreditRisk(tx: Prisma.TransactionClient, tenantId: string, agencyId: string, currency: string, newAmountMinor = 0n): Promise<{ position: AgencyPosition; aging: Aging; risk: CreditRiskResult }> {
  const position = await agencyPosition(tx, tenantId, agencyId, currency)
  const aging = await accountAging(tx, tenantId, position.accountId)
  return { position, aging, risk: riskOf(position, aging, newAmountMinor) }
}

export function riskOf(position: Pick<AgencyPosition, 'balanceMinor' | 'creditLineMinor' | 'pendingMinor'>, aging: Aging, newAmountMinor = 0n): CreditRiskResult {
  return evaluateCreditRisk({ balanceMinor: position.balanceMinor, creditLineMinor: position.creditLineMinor, pendingMinor: position.pendingMinor, unpaidMinor: aging.unpaidMinor, overdueUnpaidMinor: aging.overdueUnpaidMinor, daysOverdue: aging.daysOverdue }, AGENCY_CREDIT_RISK_POLICY, newAmountMinor)
}

const riskLogger = new Logger('CreditRisk')

/**
 * The dynamic credit control (ADR 0095) at the two points where an agency commits money: a new hold (scope HOLD, with the hold amount, so utilisation is projected) and prebook
 * (scope PREBOOK, overdue rules only: the hold being booked is already counted). In enforce mode a PAUSED agency gets a 403 AGENCY_CREDIT_PAUSED. In shadow mode nothing is
 * refused; the would-be refusal is logged (ids and codes only) and, for a hold, written as an audit event. Runs inside the caller's tenant transaction after the caller's own
 * per-agency lock, so the position it reads cannot change under it.
 */
export async function enforceCreditRisk(tx: Prisma.TransactionClient, ctx: { tenantId: string; userId: string; agencyId: string; currency: string; amountMinor: bigint; scope: 'HOLD' | 'PREBOOK' }): Promise<void> {
  const { position, aging, risk } = await agencyCreditRisk(tx, ctx.tenantId, ctx.agencyId, ctx.currency, ctx.scope === 'HOLD' ? ctx.amountMinor : 0n)
  const reasons = risk.reasons.filter(r => ctx.scope === 'HOLD' || r !== 'UTILISATION')
  if (reasons.length === 0) return
  if (creditRiskMode() === 'enforce') {
    throw new ForbiddenException({
      message: 'Your agency credit is paused. Send a payment or contact your account manager.', code: AGENCY_CREDIT_PAUSED_CODE,
      details: { reasons, currency: ctx.currency, paymentToRestoreMinor: risk.paymentToRestoreMinor.toString(), unpaidMinor: aging.unpaidMinor.toString() },
    })
  }
  riskLogger.warn(`Credit risk shadow: would pause tenant=${ctx.tenantId} agency=${ctx.agencyId} scope=${ctx.scope} reasons=${reasons.join(',')}`)
  if (ctx.scope === 'HOLD') {
    await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, actorType: 'USER', action: 'credit.risk.would_pause', entityType: 'agency', entityId: ctx.agencyId, payload: {
      mode: 'shadow', scope: ctx.scope, currency: ctx.currency, reasons, utilisationBp: position.creditLineMinor > 0n ? Number(risk.utilisationBp) : null,
      projectedUtilisationBp: risk.projectedUtilisationBp === null ? null : Number(risk.projectedUtilisationBp), holdAmountMinor: ctx.amountMinor.toString(), daysOverdue: aging.daysOverdue,
    } } })
  }
}
