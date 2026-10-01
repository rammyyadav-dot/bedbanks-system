import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// The agent portal must never ship hardcoded sample inventory, bookings or people (CLAUDE.md invariant 10).
const root = new URL('..', import.meta.url).pathname
const scanned = ['app', 'components', 'services', 'types', 'lib']
const forbidden = [
  [/DEMO_HOTELS|ENABLE_DEMO_INVENTORY|isDemo\b|source: 'mock'|status: 'demo'/, 'demo inventory switch or flag'],
  [/images\.unsplash\.com|unsplash/i, 'stock photo URL'],
  [/sample (data|inventory|bookings?|records?|property)|illustrative (sample )?amount|SAMPLE (PROPERTY|DATA)/i, 'sample data label'],
  [/FB-10\d{3}|Priya Sharma|Oliver Smith|One&Only Royal Mirage|Palace Downtown|Nikki Beach/, 'hardcoded sample booking or hotel'],
]

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '.next' ? [] : files(path)
    return /\.(ts|tsx|mjs|css)$/.test(name) && !/\.test\.mjs$/.test(name) ? [path] : []
  })
}

test('agent portal source contains no demo, mock or sample data', () => {
  const offenders = []
  for (const dir of scanned) for (const file of files(join(root, dir))) {
    const text = readFileSync(file, 'utf8')
    for (const [pattern, label] of forbidden) if (pattern.test(text)) offenders.push(`${file.replace(root, '')}: ${label}`)
  }
  assert.deepEqual(offenders, [])
})

test('the public environment example does not advertise a demo switch', () => {
  assert.doesNotMatch(readFileSync(join(root, '.env.example'), 'utf8'), /DEMO/i)
})
