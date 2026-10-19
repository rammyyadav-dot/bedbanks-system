import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { flatNav } from './nav-config'

const portalDir = path.join(__dirname, '..', '..', 'app', '(portal)')

test('every nav route has a page', () => {
  for (const item of flatNav) assert.ok(existsSync(path.join(portalDir, item.href, 'page.tsx')), `${item.href} has no page`)
})

test('only API-backed modules are marked live', () => {
  assert.deepEqual(flatNav.filter((item) => item.live).map((item) => item.href).sort(), ['/bookings', '/contracts', '/dashboard', '/hotels'])
})
