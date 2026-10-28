import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx|css)$/.test(name) ? [full] : []
  })
}

test('no source file loads fonts from a remote provider', () => {
  for (const dir of ['app', 'components', 'lib']) {
    for (const file of sourceFiles(path.join(root, dir))) {
      const text = readFileSync(file, 'utf8')
      assert.ok(!text.includes('next/font/google'), `${file} imports next/font/google`)
      assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(text), `${file} references a remote font host`)
    }
  }
})

test('the body font is the fabBeds display font, self-hosted, with a generic fallback (ADR 0104)', () => {
  const css = readFileSync(path.join(root, 'app/globals.css'), 'utf8')
  assert.match(css, /--font-body:\s*var\(--fb-font-display\);/)
  const kit = readFileSync(path.resolve(root, '../../packages/ui/src/brand-tokens.css'), 'utf8')
  assert.match(kit, /--fb-font-display:[^;]*sans-serif;/, 'the kit stack ends in a generic family')
  assert.ok(!/@import\s+url\(/.test(kit), 'the kit imports no remote stylesheet: Poppins and IBM Plex Mono are self-hosted via @fontsource')
  assert.ok(!css.includes('--font-inter'))
})
