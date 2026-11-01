import test from 'node:test'
import assert from 'node:assert/strict'
import { BankStatementError, parseBankCsv, parseBankStatement, parseCamt053, parseMt940 } from './src/bank-statement.ts'

const MT940 = `:20:STMT0001
:25:AE070331234567890123456
:28C:1/1
:60F:C261001AED1000,00
:61:2610021002D250,50NTRFPAY-2026-0042//BNK9001
:86:SETTLEMENT HOTELCO LTD PAY-2026-0042
:61:2610031003C1200,NTRFAGY-FUND-77//BNK9002
:86:?20FUNDING ?21AGY-FUND-77
:62F:C261003AED1949,50
-`

test('MT940: opening, entries and closing balance agree; direction, dates, references and info are read', () => {
  const [s] = parseMt940(MT940)
  assert.equal(s.currency, 'AED'); assert.equal(s.accountId, 'AE070331234567890123456')
  assert.equal(s.openingBalanceMinor, 100000n); assert.equal(s.closingBalanceMinor, 194950n)
  assert.deepEqual(s.entries.map((e) => [e.direction, e.amountMinor, e.valueDate, e.bookingDate, e.entryRef]), [
    ['DEBIT', 25050n, '2026-10-02', '2026-10-02', 'BNK9001'],
    ['CREDIT', 120000n, '2026-10-03', '2026-10-03', 'BNK9002'],
  ])
  assert.deepEqual(s.entries[0].references, ['BNK9001', 'PAY-2026-0042'])
  assert.match(s.entries[0].remittanceInfo, /HOTELCO LTD/)
  assert.match(s.entries[1].remittanceInfo, /AGY-FUND-77/)
})

test('MT940: a closing balance that does not equal opening plus movements is refused', () => {
  assert.throws(() => parseMt940(MT940.replace('AED1949,50', 'AED1949,51')), (e) => e instanceof BankStatementError && e.code === 'BALANCE_MISMATCH')
})

test('MT940: reversal of a credit takes money out; fraction digits beyond the currency scale and bad dates are refused', () => {
  const rev = MT940.replace('2610031003C1200,', '2610031003RC1200,').replace(':62F:C261003AED1949,50', ':62F:D261003AED450,50')
  assert.equal(parseMt940(rev)[0].entries[1].direction, 'DEBIT')
  assert.throws(() => parseMt940(MT940.replace('250,50', '250,505')), (e) => e instanceof BankStatementError && e.code === 'INVALID_AMOUNT')
  assert.throws(() => parseMt940(MT940.replace('261002', '261302')), (e) => e instanceof BankStatementError && e.code === 'INVALID_DATE')
})

test('MT940: zero amount, unknown currency and text before a tag are refused', () => {
  assert.throws(() => parseMt940(MT940.replace('250,50', '0,00')), (e) => e instanceof BankStatementError && e.code === 'INVALID_AMOUNT')
  assert.throws(() => parseMt940(MT940.replaceAll('AED', 'XXX')), (e) => e instanceof BankStatementError && e.code === 'UNSUPPORTED_CURRENCY')
  assert.throws(() => parseMt940(`garbage\n${MT940}`), (e) => e instanceof BankStatementError && e.code === 'MALFORMED')
})

const camt = (extra = '', ntry = '') => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Id>S-1</Id><Acct><Id><IBAN>AE070331234567890123456</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="AED">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-01</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="AED">${extra || '749.50'}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-02</Dt></Dt></Bal>
<Ntry><Amt Ccy="AED">250.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt><ValDt><Dt>2026-10-02</Dt></ValDt><AcctSvcrRef>BNK9001</AcctSvcrRef>
<NtryDtls><TxDtls><Refs><EndToEndId>PAY-2026-0042</EndToEndId></Refs><RmtInf><Ustrd>Hotelco &amp; Sons settlement</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
${ntry}</Stmt></BkToCstmrStmt></Document>`

test('camt.053: balances, booked entries, identifiers, entity decoding and namespaces', () => {
  const [s] = parseCamt053(camt())
  assert.equal(s.accountId, 'AE070331234567890123456'); assert.equal(s.closingBalanceMinor, 74950n)
  assert.deepEqual(s.entries.map((e) => [e.direction, e.amountMinor, e.entryRef, e.references]), [['DEBIT', 25050n, 'BNK9001', ['BNK9001', 'PAY-2026-0042']]])
  assert.equal(s.entries[0].remittanceInfo, 'Hotelco & Sons settlement')
})

test('camt.053: pending entries are skipped, reversal flips the direction, balance mismatch is refused', () => {
  const pending = `<Ntry><Amt Ccy="AED">99.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt></Ntry>`
  assert.equal(parseCamt053(camt('', pending))[0].entries.length, 1)
  const reversal = `<Ntry><Amt Ccy="AED">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt></Ntry>`
  const [s] = parseCamt053(camt('799.50', reversal))
  assert.equal(s.entries[1].direction, 'CREDIT')
  assert.throws(() => parseCamt053(camt('750.00')), (e) => e instanceof BankStatementError && e.code === 'BALANCE_MISMATCH')
})

test('camt.053: DOCTYPE and entity declarations are refused before parsing (no XXE, no entity expansion)', () => {
  const evil = `<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>${camt()}`
  assert.throws(() => parseCamt053(evil), (e) => e instanceof BankStatementError && e.code === 'UNSUPPORTED_CONSTRUCT')
  assert.throws(() => parseCamt053('<Document><BkToCstmrStmt><Stmt></Document>'), (e) => e instanceof BankStatementError && e.code === 'MALFORMED')
})

test('CSV: signed amounts, quoted cells, required columns, single currency', () => {
  const csv = 'date,amount,currency,reference,description\n2026-10-02,-250.50,AED,PAY-2026-0042,"Hotelco, settlement"\n2026-10-03,1200,AED,AGY-FUND-77,\n'
  const s = parseBankCsv(csv, { statementRef: 'C-1', accountId: 'ACC1' })
  assert.deepEqual(s.entries.map((e) => [e.direction, e.amountMinor, e.entryRef]), [['DEBIT', 25050n, 'C-1:1'], ['CREDIT', 120000n, 'C-1:2']])
  assert.equal(s.entries[0].remittanceInfo, 'Hotelco, settlement')
  assert.throws(() => parseBankCsv('date,amount\n2026-10-02,1', { statementRef: 'C', accountId: 'A' }), (e) => e instanceof BankStatementError && e.code === 'MISSING_FIELD')
  assert.throws(() => parseBankCsv(csv.replace('1200,AED', '1,200,AED'), { statementRef: 'C', accountId: 'A' }), BankStatementError)
  assert.throws(() => parseBankCsv(csv.replace('1200,AED', '12.00,USD'), { statementRef: 'C', accountId: 'A' }), (e) => e instanceof BankStatementError && e.code === 'CURRENCY_MISMATCH')
})

test('format sniffing, and error messages never echo statement content', () => {
  assert.equal(parseBankStatement(MT940)[0].format, 'MT940')
  assert.equal(parseBankStatement(camt())[0].format, 'CAMT053')
  assert.throws(() => parseBankStatement('hello'), BankStatementError)
  try { parseMt940(MT940.replace('250,50', '250,505')) } catch (e) { assert.ok(!String((e as Error).message).includes('PAY-2026')); assert.ok(!String((e as Error).message).includes('AE07033')) }
})
