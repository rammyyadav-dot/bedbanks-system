import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
test('security configuration contains required browser protections', () => { const source = readFileSync(resolve(import.meta.dirname, '../next.config.ts'), 'utf8'); for (const expected of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", 'Permissions-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'Strict-Transport-Security']) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) })
