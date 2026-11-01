import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import { STATEMENT_MAX_LINES, STATEMENT_STREAM_MAX_BYTES, STATEMENT_STREAM_MAX_LINE_BYTES } from '@bedbanks/contracts'
import { statementContentHash, validateStatementHeader, validateStatementLine, type ValidStatement, type ValidStatementLine } from './statement-import'

const NEWLINE = 0x0a

export interface StatementStreamLimits { maxBytes: number; maxLineBytes: number; maxLines: number }
export const DEFAULT_STATEMENT_STREAM_LIMITS: StatementStreamLimits = { maxBytes: STATEMENT_STREAM_MAX_BYTES, maxLineBytes: STATEMENT_STREAM_MAX_LINE_BYTES, maxLines: STATEMENT_MAX_LINES }

/**
 * Splits a byte stream into lines without ever holding more than one line (ADR 0074). Lines are decoded after the split, so a multi-byte character cut by a
 * chunk boundary is never corrupted. Total size and single-line size are enforced while reading, so a client that never sends a newline, or never stops,
 * is cut off at the limit rather than buffered.
 */
export async function* ndjsonLines(source: AsyncIterable<Buffer | Uint8Array | string>, limits: Pick<StatementStreamLimits, 'maxBytes' | 'maxLineBytes'>): AsyncGenerator<string, void, void> {
  let pending: Buffer = Buffer.alloc(0)
  let total = 0
  for await (const piece of source) {
    const chunk = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : Buffer.from(piece)
    total += chunk.length
    if (total > limits.maxBytes) throw new PayloadTooLargeException(`The statement upload must not exceed ${limits.maxBytes} bytes`)
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let start = 0
    for (let at = pending.indexOf(NEWLINE, start); at !== -1; at = pending.indexOf(NEWLINE, start)) {
      yield decodeLine(pending.subarray(start, at), limits.maxLineBytes)
      start = at + 1
    }
    pending = pending.subarray(start)
    if (pending.length > limits.maxLineBytes) throw new BadRequestException(`A statement line must not exceed ${limits.maxLineBytes} bytes`)
  }
  if (pending.length) yield decodeLine(pending, limits.maxLineBytes)
}

function decodeLine(bytes: Buffer, maxLineBytes: number): string {
  if (bytes.length > maxLineBytes) throw new BadRequestException(`A statement line must not exceed ${maxLineBytes} bytes`)
  // CRLF files are common; the carriage return is not part of the JSON.
  return bytes.toString('utf8').replace(/\r$/, '')
}

function parseObject(line: string, where: string): unknown {
  try { return JSON.parse(line) } catch { throw new BadRequestException(`${where} is not valid JSON`) }
}

/**
 * Reads a streamed statement import and returns it in the shape the JSON import produces, including the same content hash. Nothing is written here. The first
 * non-blank line is the header; each further non-blank line is validated as it arrives and the first invalid line aborts the read, so a bad file is refused
 * after reading only as far as its first error, with the 1-based line number of the file in the message. Memory is the validated lines, not the upload text.
 */
export async function parseStatementStream(source: AsyncIterable<Buffer | Uint8Array | string>, limits: StatementStreamLimits = DEFAULT_STATEMENT_STREAM_LIMITS): Promise<ValidStatement> {
  let header: ReturnType<typeof validateStatementHeader> | null = null
  const lines: ValidStatementLine[] = []
  let fileLine = 0
  for await (const raw of ndjsonLines(source, limits)) {
    fileLine += 1
    if (raw.trim() === '') continue
    const where = `line ${fileLine}`
    const parsed = parseObject(raw, where)
    if (!header) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequestException('The first line must be the statement header object')
      header = validateStatementHeader(parsed as Record<string, unknown>)
      continue
    }
    if (lines.length >= limits.maxLines) throw new BadRequestException(`A statement may have at most ${limits.maxLines} lines`)
    lines.push(validateStatementLine(parsed, lines.length + 1, where))
  }
  if (!header) throw new BadRequestException('A statement header line is required')
  if (lines.length < 1) throw new BadRequestException('At least one statement line is required')
  return { ...header, lines, contentSha256: statementContentHash(header, lines) }
}
