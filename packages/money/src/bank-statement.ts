/**
 * Bank statement parsing: SWIFT MT940, ISO 20022 camt.053 (XML) and a strict CSV, all into one canonical shape (ADR 0093).
 *
 * Pure: integer minor units as bigint, no I/O, no clock, no framework. Provider-specific layouts stop here; callers only ever see
 * `ParsedBankStatement`. Fails closed: anything unreadable, ambiguous or out of balance throws `BankStatementError` with a stable code, and
 * the message never echoes statement content (account numbers, names and remittance text are personal or sensitive data).
 * No currency conversion exists here or anywhere in this package (ADR 0029).
 */
import { minorUnitExponent } from './index'

export type BankStatementFormat = 'MT940' | 'CAMT053' | 'CSV'
export type BankDirection = 'CREDIT' | 'DEBIT'

export const BANK_STATEMENT_ERROR_CODES = [
  'EMPTY',
  'TOO_LARGE',
  'TOO_MANY_ENTRIES',
  'UNSUPPORTED_CONSTRUCT',
  'MALFORMED',
  'MISSING_FIELD',
  'INVALID_DATE',
  'INVALID_AMOUNT',
  'UNSUPPORTED_CURRENCY',
  'CURRENCY_MISMATCH',
  'BALANCE_MISMATCH',
] as const
export type BankStatementErrorCode = (typeof BANK_STATEMENT_ERROR_CODES)[number]

export class BankStatementError extends Error {
  constructor(readonly code: BankStatementErrorCode, readonly where?: string) {
    super(where ? `${code} (${where})` : code)
    this.name = 'BankStatementError'
  }
}

export interface BankStatementEntry {
  /** The bank's own reference for the movement when it gave one; otherwise `<statementRef>:<n>`. */
  entryRef: string
  direction: BankDirection
  currency: string
  /** Positive magnitude; `direction` gives the sign. */
  amountMinor: bigint
  /** YYYY-MM-DD. */
  bookingDate: string
  valueDate: string
  /** Every identifier a payer or the bank put on the movement (end-to-end id, transaction id, structured creditor reference, bank reference). */
  references: string[]
  /** Free text, whitespace-normalised. May contain personal data: matched against, never logged. */
  remittanceInfo: string
}

export interface ParsedBankStatement {
  format: BankStatementFormat
  statementRef: string
  /** IBAN or bank account number as the file states it. */
  accountId: string
  currency: string
  openingBalanceMinor: bigint | null
  closingBalanceMinor: bigint | null
  entries: BankStatementEntry[]
}

export const BANK_STATEMENT_MAX_BYTES = 10 * 1024 * 1024
export const BANK_STATEMENT_MAX_ENTRIES = 50_000

const signed = (direction: BankDirection, amountMinor: bigint): bigint => (direction === 'CREDIT' ? amountMinor : -amountMinor)

/** A real calendar date as YYYY-MM-DD, or null. */
function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function exponentOf(currency: string, where: string): number {
  try { return minorUnitExponent(currency) } catch { throw new BankStatementError('UNSUPPORTED_CURRENCY', where) }
}

/** Decimal text to integer minor units. No thousands separators, no signs, no more fraction digits than the currency allows. */
export function bankAmountToMinor(text: string, currency: string, separator: ',' | '.', where: string): bigint {
  const exponent = exponentOf(currency, where)
  const sep = separator === ',' ? ',' : '\\.'
  const match = new RegExp(`^(\\d{1,15})(?:${sep}(\\d*))?$`).exec(text.trim())
  if (!match) throw new BankStatementError('INVALID_AMOUNT', where)
  const fraction = match[2] ?? ''
  if (fraction.length > exponent) throw new BankStatementError('INVALID_AMOUNT', where)
  return BigInt(match[1]) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0')
}

function checkBalance(statement: ParsedBankStatement): void {
  const { openingBalanceMinor: open, closingBalanceMinor: close } = statement
  if (open === null || close === null) return
  let sum = open
  for (const entry of statement.entries) sum += signed(entry.direction, entry.amountMinor)
  if (sum !== close) throw new BankStatementError('BALANCE_MISMATCH', statement.statementRef)
}

function finish(statement: ParsedBankStatement, total: { entries: number }): ParsedBankStatement {
  total.entries += statement.entries.length
  if (total.entries > BANK_STATEMENT_MAX_ENTRIES) throw new BankStatementError('TOO_MANY_ENTRIES')
  for (const entry of statement.entries) if (entry.currency !== statement.currency) throw new BankStatementError('CURRENCY_MISMATCH', statement.statementRef)
  checkBalance(statement)
  return statement
}

function guardSize(text: string): void {
  if (text.trim().length === 0) throw new BankStatementError('EMPTY')
  if (text.length > BANK_STATEMENT_MAX_BYTES) throw new BankStatementError('TOO_LARGE')
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------------------------------------------------------------------
// MT940
// ---------------------------------------------------------------------------------------------------------------------------------------

interface MtField { tag: string; value: string }

function mtFields(text: string): MtField[] {
  const fields: MtField[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tag = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw)
    if (tag) { fields.push({ tag: tag[1], value: tag[2] }); continue }
    // Block wrappers and the terminating dash carry no data. Any other line continues the previous field.
    if (/^(\{\d:.*|-\}?|-)$/.test(raw.trim()) || raw.trim() === '') continue
    const last = fields[fields.length - 1]
    if (!last) throw new BankStatementError('MALFORMED', 'text before the first tag')
    last.value += `\n${raw}`
  }
  return fields
}

const MT_BALANCE = /^([CD])(\d{6})([A-Z]{3})([\d,]+)$/
const MT_ENTRY = /^(\d{6})(\d{4})?(RC|RD|C|D)[A-Z]?([\d,]+)[A-Z][A-Z0-9]{3}([^\n]*?)(?:\/\/([^\n]*))?(?:\n([\s\S]*))?$/

function mtDate(yymmdd: string, where: string): { year: number; month: number; day: number; iso: string } {
  const year = 2000 + Number(yymmdd.slice(0, 2))
  const month = Number(yymmdd.slice(2, 4))
  const day = Number(yymmdd.slice(4, 6))
  const iso = isoDate(year, month, day)
  if (!iso) throw new BankStatementError('INVALID_DATE', where)
  return { year, month, day, iso }
}

/** The booking date carries month and day only; its year is the value date's, moved one year when that is the nearer reading. */
function mtBookingDate(mmdd: string, value: { year: number; month: number }, where: string): string {
  const month = Number(mmdd.slice(0, 2))
  const day = Number(mmdd.slice(2, 4))
  let year = value.year
  if (month - value.month > 6) year -= 1
  else if (value.month - month > 6) year += 1
  const iso = isoDate(year, month, day)
  if (!iso) throw new BankStatementError('INVALID_DATE', where)
  return iso
}

function mtBalance(value: string, where: string): { currency: string; minor: bigint } {
  const m = MT_BALANCE.exec(value.trim())
  if (!m) throw new BankStatementError('MALFORMED', where)
  mtDate(m[2], where)
  return { currency: m[3], minor: signed(m[1] === 'C' ? 'CREDIT' : 'DEBIT', bankAmountToMinor(m[4], m[3], ',', where)) }
}

/** `?20` style sub-field markers (German and other national layouts) become spaces; the text is only ever searched. */
const mtInfo = (value: string): string => collapse(value.replace(/\?\d{2}/g, ' '))

/** Parses one or more MT940 statements (customer statement message). */
export function parseMt940(text: string): ParsedBankStatement[] {
  guardSize(text)
  const fields = mtFields(text)
  const statements: ParsedBankStatement[] = []
  const total = { entries: 0 }
  let current: ParsedBankStatement | null = null
  let statementRef = ''
  let accountId = ''
  let lastEntry: BankStatementEntry | null = null
  const close = () => { if (current) statements.push(finish(current, total)); current = null; lastEntry = null }

  for (const { tag, value } of fields) {
    if (tag === '20') { close(); statementRef = collapse(value); accountId = ''; continue }
    if (tag === '25') { accountId = collapse(value); continue }
    if (tag === '60F' || tag === '60M') {
      close()
      if (!statementRef || !accountId) throw new BankStatementError('MISSING_FIELD', 'tag 20 or 25')
      const open = mtBalance(value, 'tag 60')
      current = { format: 'MT940', statementRef, accountId, currency: open.currency, openingBalanceMinor: open.minor, closingBalanceMinor: null, entries: [] }
      continue
    }
    if (!current) {
      if (['61', '86', '62F', '62M'].includes(tag)) throw new BankStatementError('MISSING_FIELD', 'opening balance (tag 60)')
      continue
    }
    if (tag === '61') {
      const m = MT_ENTRY.exec(value.trim())
      if (!m) throw new BankStatementError('MALFORMED', 'tag 61')
      const valueDate = mtDate(m[1], 'tag 61')
      const bookingDate = m[2] ? mtBookingDate(m[2], valueDate, 'tag 61') : valueDate.iso
      const reversal = m[3].startsWith('R')
      // A reversal of a credit takes money out, and a reversal of a debit puts it back.
      const credit = m[3].endsWith('C') !== reversal
      const customerRef = collapse(m[5] ?? '')
      const bankRef = collapse(m[6] ?? '')
      const references = [bankRef, customerRef].filter((r) => r !== '' && r.toUpperCase() !== 'NONREF')
      lastEntry = {
        entryRef: bankRef || (customerRef && customerRef.toUpperCase() !== 'NONREF' ? customerRef : `${statementRef}:${current.entries.length + 1}`),
        direction: credit ? 'CREDIT' : 'DEBIT',
        currency: current.currency,
        amountMinor: bankAmountToMinor(m[4], current.currency, ',', 'tag 61'),
        bookingDate,
        valueDate: valueDate.iso,
        references,
        remittanceInfo: collapse(m[7] ?? ''),
      }
      if (lastEntry.amountMinor === 0n) throw new BankStatementError('INVALID_AMOUNT', 'tag 61')
      current.entries.push(lastEntry)
      continue
    }
    if (tag === '86') {
      if (lastEntry) lastEntry.remittanceInfo = collapse(`${lastEntry.remittanceInfo} ${mtInfo(value)}`)
      continue
    }
    if (tag === '62F' || tag === '62M') {
      const closing = mtBalance(value, 'tag 62')
      if (closing.currency !== current.currency) throw new BankStatementError('CURRENCY_MISMATCH', 'tag 62')
      current.closingBalanceMinor = closing.minor
      lastEntry = null
    }
  }
  close()
  if (statements.length === 0) throw new BankStatementError('MISSING_FIELD', 'no statement found')
  return statements
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// camt.053 (ISO 20022 bank-to-customer statement)
// ---------------------------------------------------------------------------------------------------------------------------------------

interface XmlNode { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] }

const XML_TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g
const XML_ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const XML_MAX_DEPTH = 40

function xmlDecode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_m, ref: string) => {
    if (ref === 'lt') return '<'
    if (ref === 'gt') return '>'
    if (ref === 'amp') return '&'
    if (ref === 'quot') return '"'
    if (ref === 'apos') return "'"
    const code = ref.startsWith('#x') ? parseInt(ref.slice(2), 16) : Number(ref.slice(1))
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
  })
}

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1)

/**
 * A deliberately small XML reader for bank files. DOCTYPE and entity declarations are refused outright, which removes external-entity and
 * entity-expansion attacks; there is no schema or namespace processing.
 */
function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BankStatementError('UNSUPPORTED_CONSTRUCT', 'DOCTYPE or ENTITY')
  const root: XmlNode = { name: '#root', attrs: {}, text: '', children: [] }
  const stack: XmlNode[] = [root]
  for (const m of xml.matchAll(XML_TOKEN)) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) { top.text += m[1]; continue }
    if (m[3] !== undefined) {
      if (m[2] === '/') {
        if (stack.length < 2 || stack[stack.length - 1].name !== localName(m[3])) throw new BankStatementError('MALFORMED', 'xml nesting')
        stack.pop()
        continue
      }
      const attrs: Record<string, string> = {}
      for (const a of m[4].matchAll(XML_ATTR)) attrs[localName(a[1])] = xmlDecode(a[2] ?? a[3] ?? '')
      const node: XmlNode = { name: localName(m[3]), attrs, text: '', children: [] }
      top.children.push(node)
      if (m[5] !== '/') {
        if (stack.length > XML_MAX_DEPTH) throw new BankStatementError('MALFORMED', 'xml depth')
        stack.push(node)
      }
      continue
    }
    if (m[6] !== undefined) top.text += xmlDecode(m[6])
  }
  if (stack.length !== 1) throw new BankStatementError('MALFORMED', 'xml unclosed element')
  return root
}

const kids = (node: XmlNode | undefined, name: string): XmlNode[] => (node ? node.children.filter((c) => c.name === name) : [])
function at(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = node
  for (const name of path) { cur = kids(cur, name)[0]; if (!cur) return undefined }
  return cur
}
const textOf = (node: XmlNode | undefined): string => collapse(node?.text ?? '')
const requireText = (node: XmlNode | undefined, where: string): string => {
  const t = textOf(node)
  if (!t) throw new BankStatementError('MISSING_FIELD', where)
  return t
}

function camtDate(node: XmlNode | undefined, where: string): string {
  const raw = textOf(at(node, 'Dt')) || textOf(at(node, 'DtTm')).slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  const iso = m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null
  if (!iso) throw new BankStatementError('INVALID_DATE', where)
  return iso
}

function camtAmount(node: XmlNode | undefined, where: string): { currency: string; minor: bigint } {
  const currency = node?.attrs.Ccy ?? ''
  if (!/^[A-Z]{3}$/.test(currency)) throw new BankStatementError('MISSING_FIELD', `${where} currency`)
  return { currency, minor: bankAmountToMinor(textOf(node), currency, '.', where) }
}

function camtDirection(node: XmlNode | undefined, where: string): BankDirection {
  const v = textOf(node)
  if (v === 'CRDT') return 'CREDIT'
  if (v === 'DBIT') return 'DEBIT'
  throw new BankStatementError('MISSING_FIELD', `${where} CdtDbtInd`)
}

/** Parses every Stmt in a camt.053 document. Only booked entries are read; pending or informational ones are skipped. */
export function parseCamt053(xml: string): ParsedBankStatement[] {
  guardSize(xml)
  const document = parseXml(xml)
  const message = at(document, 'Document', 'BkToCstmrStmt')
  const stmts = kids(message, 'Stmt')
  if (stmts.length === 0) throw new BankStatementError('MISSING_FIELD', 'BkToCstmrStmt/Stmt')
  const total = { entries: 0 }
  return stmts.map((stmt, index) => {
    const where = `Stmt[${index}]`
    const statementRef = requireText(at(stmt, 'Id'), `${where}/Id`)
    const accountId = textOf(at(stmt, 'Acct', 'Id', 'IBAN')) || requireText(at(stmt, 'Acct', 'Id', 'Othr', 'Id'), `${where}/Acct/Id`)
    let opening: { currency: string; minor: bigint } | null = null
    let closing: { currency: string; minor: bigint } | null = null
    for (const bal of kids(stmt, 'Bal')) {
      const code = textOf(at(bal, 'Tp', 'CdOrPrtry', 'Cd'))
      if (code !== 'OPBD' && code !== 'CLBD') continue
      const amount = camtAmount(at(bal, 'Amt'), `${where}/Bal`)
      const value = signed(camtDirection(at(bal, 'CdtDbtInd'), `${where}/Bal`), amount.minor)
      if (code === 'OPBD') opening = { currency: amount.currency, minor: value }
      else closing = { currency: amount.currency, minor: value }
    }
    const currency = opening?.currency ?? closing?.currency ?? textOf(at(stmt, 'Acct', 'Ccy'))
    if (!/^[A-Z]{3}$/.test(currency)) throw new BankStatementError('MISSING_FIELD', `${where} currency`)
    if (closing && closing.currency !== currency) throw new BankStatementError('CURRENCY_MISMATCH', `${where}/Bal`)

    const entries: BankStatementEntry[] = []
    for (const ntry of kids(stmt, 'Ntry')) {
      const status = textOf(at(ntry, 'Sts', 'Cd')) || textOf(at(ntry, 'Sts'))
      if (status && status !== 'BOOK') continue
      const ewhere = `${where}/Ntry[${entries.length}]`
      const amount = camtAmount(at(ntry, 'Amt'), ewhere)
      if (amount.minor === 0n) throw new BankStatementError('INVALID_AMOUNT', ewhere)
      // RvslInd true: the entry reverses an earlier one, so its direction is the opposite of what CdtDbtInd says.
      const reversal = textOf(at(ntry, 'RvslInd')).toLowerCase() === 'true'
      const stated = camtDirection(at(ntry, 'CdtDbtInd'), ewhere)
      const references: string[] = []
      const remittance: string[] = []
      const bankRef = textOf(at(ntry, 'AcctSvcrRef'))
      if (bankRef) references.push(bankRef)
      for (const tx of kids(at(ntry, 'NtryDtls'), 'TxDtls')) {
        for (const ref of ['EndToEndId', 'TxId', 'InstrId', 'MndtId']) {
          const v = textOf(at(tx, 'Refs', ref))
          if (v && v.toUpperCase() !== 'NOTPROVIDED') references.push(v)
        }
        for (const u of kids(at(tx, 'RmtInf'), 'Ustrd')) remittance.push(textOf(u))
        const structured = textOf(at(tx, 'RmtInf', 'Strd', 'CdtrRefInf', 'Ref'))
        if (structured) references.push(structured)
      }
      const additional = textOf(at(ntry, 'AddtlNtryInf'))
      if (additional) remittance.push(additional)
      entries.push({
        entryRef: bankRef || references[0] || `${statementRef}:${entries.length + 1}`,
        direction: reversal ? (stated === 'CREDIT' ? 'DEBIT' : 'CREDIT') : stated,
        currency: amount.currency,
        amountMinor: amount.minor,
        bookingDate: camtDate(at(ntry, 'BookgDt'), `${ewhere}/BookgDt`),
        valueDate: camtDate(at(ntry, 'ValDt') ?? at(ntry, 'BookgDt'), `${ewhere}/ValDt`),
        references: [...new Set(references)],
        remittanceInfo: collapse(remittance.join(' ')),
      })
    }
    return finish({ format: 'CAMT053', statementRef, accountId, currency, openingBalanceMinor: opening?.minor ?? null, closingBalanceMinor: closing?.minor ?? null, entries }, total)
  })
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------------------------------

function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1 } else quoted = false } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(cell); cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  if (quoted) throw new BankStatementError('MALFORMED', 'csv unterminated quote')
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

/**
 * One account, one currency per file. Header row required, names case-insensitive: `date`, `amount`, `currency`, `reference`, and optionally
 * `value_date`, `description`, `id`. `amount` is a signed decimal with a dot (a leading minus is money out); no thousands separators.
 * A CSV carries no balances, so the balance check does not apply to it.
 */
export function parseBankCsv(text: string, input: { statementRef: string; accountId: string }): ParsedBankStatement {
  guardSize(text)
  const rows = csvRows(text)
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase())
  const col = (name: string): number => header.indexOf(name)
  for (const required of ['date', 'amount', 'currency', 'reference']) if (col(required) < 0) throw new BankStatementError('MISSING_FIELD', `csv column ${required}`)
  if (rows.length === 0) throw new BankStatementError('EMPTY')
  if (rows.length > BANK_STATEMENT_MAX_ENTRIES) throw new BankStatementError('TOO_MANY_ENTRIES')
  const entries: BankStatementEntry[] = []
  let currency = ''
  rows.forEach((cells, index) => {
    const where = `csv row ${index + 2}`
    if (cells.length > header.length) throw new BankStatementError('MALFORMED', where)
    const get = (name: string): string => (col(name) >= 0 ? (cells[col(name)] ?? '').trim() : '')
    const cur = get('currency')
    if (!/^[A-Z]{3}$/.test(cur)) throw new BankStatementError('MISSING_FIELD', `${where} currency`)
    if (currency && cur !== currency) throw new BankStatementError('CURRENCY_MISMATCH', where)
    currency = cur
    const rawAmount = get('amount')
    const negative = rawAmount.startsWith('-')
    const amountMinor = bankAmountToMinor(negative ? rawAmount.slice(1) : rawAmount, cur, '.', where)
    if (amountMinor === 0n) throw new BankStatementError('INVALID_AMOUNT', where)
    const day = (value: string): string => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      const iso = m ? isoDate(Number(m[1]), Number(m[2]), Number(m[3])) : null
      if (!iso) throw new BankStatementError('INVALID_DATE', where)
      return iso
    }
    const bookingDate = day(get('date'))
    const reference = get('reference')
    entries.push({
      entryRef: get('id') || `${input.statementRef}:${index + 1}`,
      direction: negative ? 'DEBIT' : 'CREDIT',
      currency: cur,
      amountMinor,
      bookingDate,
      valueDate: get('value_date') ? day(get('value_date')) : bookingDate,
      references: reference ? [reference] : [],
      remittanceInfo: collapse(get('description')),
    })
  })
  return finish({ format: 'CSV', statementRef: input.statementRef, accountId: input.accountId, currency, openingBalanceMinor: null, closingBalanceMinor: null, entries }, { entries: 0 })
}

/** Picks MT940 or camt.053 from the content. CSV needs its statement identity from the caller, so it is called explicitly. */
export function parseBankStatement(text: string): ParsedBankStatement[] {
  const head = text.trimStart().slice(0, 64)
  if (head.startsWith('<')) return parseCamt053(text)
  if (/^(\{1:|:20:)/.test(head)) return parseMt940(text)
  throw new BankStatementError('MALFORMED', 'unrecognised format')
}
