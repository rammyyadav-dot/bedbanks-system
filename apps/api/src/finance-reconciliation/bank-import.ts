import { UnprocessableEntityException, BadRequestException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { BANK_IMPORT_FORMATS, BANK_IMPORT_MAX_CONTENT_CHARS, type BankImportFormat } from '@bedbanks/contracts'
import { BankStatementError, parseBankCsv, parseCamt053, parseMt940, type BankStatementEntry, type ParsedBankStatement } from '@bedbanks/money'

const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,80}$/
const CONTROL = /[\u0000-\u001f\u007f]/

export interface PreparedBankImport {
  requestId: string
  format: BankImportFormat
  statementRef: string
  /** SHA-256 of the tenant and the account number: an identity key, never the number itself. */
  accountSha256: string
  accountLast4: string
  currency: string
  periodStart: string
  periodEnd: string
  openingMinor: bigint | null
  closingMinor: bigint | null
  entries: BankStatementEntry[]
  /** SHA-256 over the account, currency and the canonical, order-independent entries: the same statement cannot be imported twice under another number. */
  contentSha256: string
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

function text(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string') throw new BadRequestException(`${name} is required`)
  const t = value.trim()
  if (t.length < 1 || t.length > max || CONTROL.test(t)) throw new BadRequestException(`${name} must be 1 to ${max} printable characters`)
  return t
}

export function bankContentHash(accountSha256: string, currency: string, entries: readonly BankStatementEntry[]): string {
  const canonical = entries.map((e) => [e.entryRef, e.valueDate, e.direction, e.currency, e.amountMinor, [...e.references].sort().join('|')].join('\u0000')).sort()
  return sha(`${accountSha256}|${currency}\n${canonical.join('\n')}`)
}

/**
 * Validates a bank statement import (ADR 0093) and parses it with the pure parsers. Nothing is trusted from the body except what is checked here; the tenant
 * comes from the session. A parse failure is a 422 with a stable code and never echoes statement content.
 */
export function prepareBankImport(tenantId: string, body: unknown): PreparedBankImport {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A bank statement import object is required')
  const b = body as Record<string, unknown>
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) throw new BadRequestException('requestId must be 8 to 80 characters (letters, digits, . _ : -)')
  const format = b.format
  if (typeof format !== 'string' || !(BANK_IMPORT_FORMATS as readonly string[]).includes(format)) throw new BadRequestException(`format must be one of ${BANK_IMPORT_FORMATS.join(', ')}`)
  if (typeof b.content !== 'string' || b.content.length === 0) throw new BadRequestException('content is required')
  if (b.content.length > BANK_IMPORT_MAX_CONTENT_CHARS) throw new BadRequestException(`content must not exceed ${BANK_IMPORT_MAX_CONTENT_CHARS} characters`)

  let parsed: ParsedBankStatement[]
  try {
    if (format === 'MT940') parsed = parseMt940(b.content)
    else if (format === 'CAMT053') parsed = parseCamt053(b.content)
    else parsed = [parseBankCsv(b.content, { statementRef: text('statementRef', b.statementRef, 80), accountId: text('accountId', b.accountId, 80) })]
  } catch (error) {
    if (error instanceof BankStatementError) throw new UnprocessableEntityException({ message: 'The bank statement could not be read', code: `BANK_STATEMENT_${error.code}` })
    throw error
  }
  if (parsed.length !== 1) throw new UnprocessableEntityException({ message: 'Import one statement per file', code: 'BANK_STATEMENT_MULTIPLE' })
  const [s] = parsed
  if (s.entries.length === 0) throw new UnprocessableEntityException({ message: 'The statement has no movements', code: 'BANK_STATEMENT_EMPTY' })
  const account = s.accountId.replace(/\s+/g, '').toUpperCase()
  const accountSha256 = sha(`${tenantId}|${account}`)
  const dates = s.entries.map((e) => e.bookingDate).sort()
  return {
    requestId: b.requestId, format: format as BankImportFormat, statementRef: s.statementRef.slice(0, 80), accountSha256, accountLast4: account.slice(-4), currency: s.currency,
    periodStart: dates[0], periodEnd: dates[dates.length - 1], openingMinor: s.openingBalanceMinor, closingMinor: s.closingBalanceMinor, entries: s.entries,
    contentSha256: bankContentHash(accountSha256, s.currency, s.entries),
  }
}
