import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import { ndjsonLines, parseStatementStream, type StatementStreamLimits } from './statement-stream'
import { validateStatementImport } from './statement-import'

const header = { supplierId: 'sup1', statementRef: 'ST-001', periodStart: '2026-10-01', periodEnd: '2026-10-31', requestId: 'req-0001-abc' }
const line = (n: number, extra: Record<string, unknown> = {}) => ({ reference: `BK-${n}`, kind: 'CHARGE', currency: 'USD', amount: `${n}.50`, ...extra })
const ndjson = (rows: unknown[], eol = '\n') => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(eol) + eol
async function* chunked(text: string, size: number) { const b = Buffer.from(text, 'utf8'); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size) }
const limits = (over: Partial<StatementStreamLimits> = {}): StatementStreamLimits => ({ maxBytes: 1_000_000, maxLineBytes: 4096, maxLines: 5000, ...over })

describe('streamed statement import (ADR 0074)', () => {
  it('produces exactly what the JSON import produces, including the content hash, whatever the chunking', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => line(i + 1))
    const viaJson = validateStatementImport({ ...header, lines: rows })
    for (const size of [1, 7, 64, 100_000]) {
      const viaStream = await parseStatementStream(chunked(ndjson([header, ...rows]), size))
      expect(viaStream.contentSha256).toBe(viaJson.contentSha256)
      expect(viaStream.lines).toEqual(viaJson.lines)
      expect(viaStream).toMatchObject({ supplierId: 'sup1', statementRef: 'ST-001', requestId: 'req-0001-abc' })
    }
  })

  it('does not corrupt multi-byte characters split across chunks, and accepts CRLF and blank lines', async () => {
    const rows = [line(1, { reference: 'BK-ÅÉ-日本' }), line(2)]
    const text = ndjson([header, '', ...rows], '\r\n')
    const parsed = await parseStatementStream(chunked(text, 3))
    expect(parsed.lines.map((l) => l.reference)).toEqual(['BK-ÅÉ-日本', 'BK-2'])
    expect(parsed.lines.map((l) => l.lineNo)).toEqual([1, 2])
  })

  it('names the file line of the first invalid line and stops reading there', async () => {
    let produced = 0
    async function* source() { for (const row of [header, line(1), line(2, { amount: 12.5 }), line(3), line(4)]) { produced += 1; yield Buffer.from(JSON.stringify(row) + '\n') } }
    await expect(parseStatementStream(source())).rejects.toThrow('line 3.amount must be a decimal string')
    expect(produced).toBe(3)
  })

  it('refuses malformed JSON, a non-object header, a missing header, no lines and a bad header field', async () => {
    await expect(parseStatementStream(chunked(ndjson([header, '{nope']), 10))).rejects.toThrow('line 2 is not valid JSON')
    await expect(parseStatementStream(chunked(ndjson(['[1,2]']), 10))).rejects.toThrow('first line must be the statement header')
    await expect(parseStatementStream(chunked('', 10))).rejects.toThrow('header line is required')
    await expect(parseStatementStream(chunked(ndjson([header]), 10))).rejects.toThrow('At least one statement line')
    await expect(parseStatementStream(chunked(ndjson([{ ...header, requestId: 'x' }, line(1)]), 10))).rejects.toThrow('requestId')
  })

  it('enforces the line count, the line size and the upload size while reading', async () => {
    await expect(parseStatementStream(chunked(ndjson([header, line(1), line(2), line(3)]), 16), limits({ maxLines: 2 }))).rejects.toThrow('at most 2 lines')
    await expect(parseStatementStream(chunked(ndjson([header, line(1, { reference: 'x'.repeat(500) })]), 16), limits({ maxLineBytes: 200 }))).rejects.toBeInstanceOf(BadRequestException)
    // no newline at all: cut off at the line limit instead of buffering the rest
    let sent = 0
    async function* endless() { while (sent < 10_000_000) { sent += 1024; yield Buffer.alloc(1024, 0x61) } }
    await expect(parseStatementStream(endless(), limits({ maxLineBytes: 4096 }))).rejects.toBeInstanceOf(BadRequestException)
    expect(sent).toBeLessThan(20_000)
    await expect(parseStatementStream(chunked(ndjson([header, ...Array.from({ length: 100 }, (_, i) => line(i))]), 64), limits({ maxBytes: 500 }))).rejects.toBeInstanceOf(PayloadTooLargeException)
  })

  it('splits lines without retaining earlier ones', async () => {
    const out: string[] = []
    for await (const l of ndjsonLines(chunked('a\nbb\nccc', 2), { maxBytes: 100, maxLineBytes: 10 })) out.push(l)
    expect(out).toEqual(['a', 'bb', 'ccc'])
  })
})
