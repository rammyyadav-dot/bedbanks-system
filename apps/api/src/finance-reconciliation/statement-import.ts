import { BadRequestException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { STATEMENT_LINE_KINDS, STATEMENT_MAX_LINES, type StatementLineKindName } from '@bedbanks/contracts'
import { majorUnitsToMinor, normaliseReference } from '@bedbanks/money'
import { dayParam, idParam } from '../admin-operations/query-params'

export interface ValidStatementLine { lineNo: number; reference: string; kind: StatementLineKindName; currency: string; amountMinor: bigint }
export interface ValidStatement {
  supplierId: string
  statementRef: string
  periodStart: Date
  periodEnd: Date
  requestId: string
  lines: ValidStatementLine[]
  /** SHA-256 over the period and the canonical, order-independent lines: the same statement cannot be imported twice under another number. */
  contentSha256: string
}

const MAX_PERIOD_DAYS = 400
const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,80}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const DAY_MS = 86_400_000

function text(name: string, value: unknown, max = 80): string {
  if (typeof value !== 'string') throw new BadRequestException(`${name} is required`)
  const t = value.trim()
  if (t.length < 1 || t.length > max || CONTROL.test(t)) throw new BadRequestException(`${name} must be 1 to ${max} printable characters`)
  return t
}

export interface StatementHeader { supplierId: string; statementRef: string; periodStart: Date; periodEnd: Date; requestId: string }

/** The statement-level fields (everything except the lines). Shared by the JSON import and the streamed import (ADR 0074). */
export function validateStatementHeader(b: Record<string, unknown>): StatementHeader {
  const supplierId = idParam('supplierId', b.supplierId)
  if (!supplierId) throw new BadRequestException('supplierId is required')
  const statementRef = text('statementRef', b.statementRef)
  const periodStart = dayParam('periodStart', b.periodStart)
  const periodEnd = dayParam('periodEnd', b.periodEnd)
  if (!periodStart || !periodEnd) throw new BadRequestException('periodStart and periodEnd are required (YYYY-MM-DD)')
  if (periodStart > periodEnd) throw new BadRequestException('periodStart must not be after periodEnd')
  if ((periodEnd.getTime() - periodStart.getTime()) / DAY_MS > MAX_PERIOD_DAYS) throw new BadRequestException(`The statement period must not exceed ${MAX_PERIOD_DAYS} days`)
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) throw new BadRequestException('requestId must be 8 to 80 characters (letters, digits, . _ : -)')
  return { supplierId, statementRef, periodStart, periodEnd, requestId: b.requestId }
}

/** One statement line. `where` names it in error messages (`lines[3]` for JSON, `line 4` for a stream). */
export function validateStatementLine(raw: unknown, lineNo: number, where: string): ValidStatementLine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException(`${where} must be an object`)
  const l = raw as Record<string, unknown>
  const kind = l.kind
  if (typeof kind !== 'string' || !(STATEMENT_LINE_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`${where}.kind must be one of ${STATEMENT_LINE_KINDS.join(', ')}`)
  const currency = l.currency
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new BadRequestException(`${where}.currency must be an ISO-4217 alpha code`)
  if (typeof l.amount !== 'string') throw new BadRequestException(`${where}.amount must be a decimal string`)
  let minor: number
  try { minor = majorUnitsToMinor(l.amount, currency) } catch (error) { throw new BadRequestException(`${where}.amount: ${error instanceof Error ? error.message : 'invalid'}`) }
  if (minor <= 0) throw new BadRequestException(`${where}.amount must be greater than zero`)
  return { lineNo, reference: text(`${where}.reference`, l.reference), kind: kind as StatementLineKindName, currency, amountMinor: BigInt(minor) }
}

/** SHA-256 over the period and the canonical, order-independent lines (see ValidStatement.contentSha256). */
export function statementContentHash(header: Pick<StatementHeader, 'periodStart' | 'periodEnd'>, lines: readonly ValidStatementLine[]): string {
  const canonical = lines.map((l) => `${normaliseReference(l.reference)}|${l.kind}|${l.currency}|${l.amountMinor}`).sort()
  return createHash('sha256').update(`${header.periodStart.toISOString().slice(0, 10)}|${header.periodEnd.toISOString().slice(0, 10)}\n${canonical.join('\n')}`).digest('hex')
}

/**
 * Validates a statement import (ADR 0070). Amounts arrive as major-unit decimal strings and are converted with the currency exponent; a JSON number is
 * refused so a binary float never reaches money. Nothing is trusted from the body except what is checked here; the tenant comes from the session.
 */
export function validateStatementImport(body: unknown): ValidStatement {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A statement object is required')
  const b = body as Record<string, unknown>
  const header = validateStatementHeader(b)
  if (!Array.isArray(b.lines) || b.lines.length < 1) throw new BadRequestException('At least one statement line is required')
  if (b.lines.length > STATEMENT_MAX_LINES) throw new BadRequestException(`A statement may have at most ${STATEMENT_MAX_LINES} lines`)
  const lines = b.lines.map((raw, index) => validateStatementLine(raw, index + 1, `lines[${index}]`))
  return { ...header, lines, contentSha256: statementContentHash(header, lines) }
}
