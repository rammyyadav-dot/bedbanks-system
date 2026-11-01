import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStatementCsv } from './statement-csv'

test('parses comma, semicolon and tab statements, keeps amounts as text, upper-cases kind and currency', () => {
  const comma = parseStatementCsv('reference,kind,currency,amount\nBK-1,charge,aed,100.50\nBK-2,CREDIT,AED,80')
  assert.deepEqual(comma, { lines: [{ reference: 'BK-1', kind: 'CHARGE', currency: 'AED', amount: '100.50' }, { reference: 'BK-2', kind: 'CREDIT', currency: 'AED', amount: '80' }], errors: [] })
  assert.deepEqual(parseStatementCsv('amount;currency;kind;reference\n1.00;USD;SURCHARGE;X1').lines, [{ reference: 'X1', kind: 'SURCHARGE', currency: 'USD', amount: '1.00' }])
  assert.equal(parseStatementCsv('Reference\tKind\tCurrency\tAmount\r\nB1\tCHARGE\tJPY\t5000\r\n').lines.length, 1)
})

test('quoted fields may contain the delimiter and doubled quotes', () => {
  assert.equal(parseStatementCsv('reference,kind,currency,amount\n"BK,1",CHARGE,AED,1').lines[0].reference, 'BK,1')
  assert.equal(parseStatementCsv('reference,kind,currency,amount\n"BK ""1""",CHARGE,AED,1').lines[0].reference, 'BK "1"')
})

test('reports each bad row by number and never guesses', () => {
  const r = parseStatementCsv('reference,kind,currency,amount\n,CHARGE,AED,1\nB2,REFUND,AED,1\nB3,CHARGE,AE,1\nB4,CHARGE,AED,1,5\nB5,CHARGE,AED,-3\nB6,CHARGE,AED,1,00')
  assert.deepEqual(r.errors, [
    'Row 2: reference is empty', 'Row 3: kind must be CHARGE, CREDIT, SURCHARGE', 'Row 4: currency must be a three-letter code',
    'Row 5: has 5 columns but the header has 4; amounts must use a dot as the decimal separator', 'Row 6: amount must be a positive number such as 123.45',
    'Row 7: has 5 columns but the header has 4; amounts must use a dot as the decimal separator',
  ])
  assert.deepEqual(r.lines, [])
})

test('needs the header row; empty input is not an error', () => {
  assert.deepEqual(parseStatementCsv('B1,CHARGE,AED,1').errors, ['The first row must name the columns: reference, kind, currency, amount'])
  assert.deepEqual(parseStatementCsv('  \n'), { lines: [], errors: [] })
})
