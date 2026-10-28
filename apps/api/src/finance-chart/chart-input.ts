import { BadRequestException } from '@nestjs/common'
import { GL_ACCOUNT_TYPE_NAMES, GL_CATEGORY_NAMES, GL_CHART_FAILURE, type GlAccountCreateRequest, type GlAccountTypeName, type GlCategoryName } from '@bedbanks/contracts'

const bad = (message: string) => new BadRequestException({ message, code: GL_CHART_FAILURE.invalid })
const CONTROL = /[\u0000-\u001f\u007f]/
const ID = /^[A-Za-z0-9_.:-]{1,80}$/

/** Validates a new account. Pure, so every refusal is unit-tested without a database. */
export function parseAccountCreate(body: unknown): GlAccountCreateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A request body is required')
  const b = body as Record<string, unknown>
  const code = typeof b.code === 'string' ? b.code.trim() : ''
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,15}$/.test(code)) throw bad('code must be 1 to 16 letters, digits, . _ - and start with a letter or digit')
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (name.length < 2 || name.length > 120 || CONTROL.test(name)) throw bad('name must be 2 to 120 printable characters')
  if (typeof b.type !== 'string' || !(GL_ACCOUNT_TYPE_NAMES as readonly string[]).includes(b.type)) throw bad(`type must be one of ${GL_ACCOUNT_TYPE_NAMES.join(', ')}`)
  return { code, name, type: b.type as GlAccountTypeName }
}

export interface MappingInput { category: GlCategoryName; debitAccountId: string; creditAccountId: string }

export function parseMappingSet(body: unknown): MappingInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A request body is required')
  const b = body as Record<string, unknown>
  if (typeof b.category !== 'string' || !(GL_CATEGORY_NAMES as readonly string[]).includes(b.category)) throw bad(`category must be one of ${GL_CATEGORY_NAMES.join(', ')}`)
  const debitAccountId = typeof b.debitAccountId === 'string' ? b.debitAccountId.trim() : ''
  const creditAccountId = typeof b.creditAccountId === 'string' ? b.creditAccountId.trim() : ''
  if (!ID.test(debitAccountId) || !ID.test(creditAccountId)) throw bad('debitAccountId and creditAccountId are required')
  if (debitAccountId === creditAccountId) throw bad('The debit and credit accounts must differ')
  return { category: b.category as GlCategoryName, debitAccountId, creditAccountId }
}

/** `YYYY-MM` for the journal. */
export function parseMonth(value: unknown): string {
  const month = typeof value === 'string' ? value.trim() : ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('month must be a calendar month written YYYY-MM')
  return month
}
