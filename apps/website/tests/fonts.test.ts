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

test('the body font is a system stack with a generic fallback', () => {
  const css = readFileSync(path.join(root, 'app/globals.css'), 'utf8')
  assert.match(css, /--font-body:[^;]*system-ui[^;]*sans-serif;/)
  assert.ok(!css.includes('--font-inter'))
})
