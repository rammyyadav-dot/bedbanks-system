import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOKENS_FILE, parseLightTokens, renderTokensCss } from '../lib/theme/tokens'

const file = join(import.meta.dirname, '..', TOKENS_FILE)
const next = renderTokensCss(parseLightTokens(readFileSync(file, 'utf8')))
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== next) { console.error(`${TOKENS_FILE} is out of date. Run pnpm theme:tokens.`); process.exit(1) }
} else writeFileSync(file, next)
