import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Given a clean agent tree, When Next.js reads tsc --showConfig, Then the output is JSON and type checking stays enabled', () => {
  const require = createRequire(path.join(appDir, 'package.json'))
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '--showConfig', '--project', path.join(appDir, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: appDir,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.compilerOptions.noEmit, true)
  assert.notEqual(parsed.compilerOptions.noCheck, true)
})
