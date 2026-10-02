import { BadRequestException } from '@nestjs/common'

/** Identifier shapes seen in this codebase (cuid, uuid, request ids). No wildcard or path characters. */
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,80}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export interface PageParams { page: number; pageSize: number; skip: number; take: number }

/** Strict server-side pagination. Non-numeric or out-of-range values are rejected, never silently widened. */
export function pageParams(query: { page?: unknown; pageSize?: unknown }): PageParams {
  const page = query.page === undefined || query.page === '' ? 1 : Number(query.page)
  const pageSize = query.pageSize === undefined || query.pageSize === '' ? DEFAULT_PAGE_SIZE : Number(query.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new BadRequestException('Invalid page')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new BadRequestException(`Invalid pageSize (1-${MAX_PAGE_SIZE})`)
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

export function idParam(name: string, value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new BadRequestException(`Invalid ${name}`)
  return value
}

export function enumParam<T extends string>(name: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new BadRequestException(`Invalid ${name}`)
  return value as T
}

/** A calendar day (YYYY-MM-DD) as a UTC midnight Date. Impossible dates such as 2026-02-31 are rejected. */
export function dayParam(name: string, value: unknown): Date | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !DAY.test(value)) throw new BadRequestException(`Invalid ${name}`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`Invalid ${name}`)
  return date
}

/** The last instant of a day, for inclusive upper bounds on timestamp columns. */
export function endOfDay(date: Date): Date { return new Date(date.getTime() + 86_400_000 - 1) }

/** Free text for case-insensitive "contains" search. Length-limited; Prisma escapes LIKE wildcards in `contains`. */
export function textParam(name: string, value: unknown, max = 64): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new BadRequestException(`Invalid ${name}`)
  const text = value.trim()
  if (!text) return undefined
  if (text.length > max || /[\u0000-\u001f]/.test(text)) throw new BadRequestException(`Invalid ${name}`)
  return text
}

export function boolParam(name: string, value: unknown): boolean | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'true' || value === true) return true
  if (value === 'false' || value === false) return false
  throw new BadRequestException(`Invalid ${name}`)
}

export function intParam(name: string, value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`Invalid ${name}`)
  return n
}

export function paged<T>(items: T[], page: PageParams, total: number) { return { items, page: page.page, pageSize: page.pageSize, total } }
