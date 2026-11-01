import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { breadcrumbItems, firstAccessibleRoute, humanizeSegment } from './shell-navigation'
import { activeMembership } from './api/tenant-context'
import { navSections } from '../components/layout/nav-config'

const root = join(import.meta.dirname, '..')

test('humanizeSegment never echoes opaque identifiers', () => {
  assert.equal(humanizeSegment('new'), 'New')
  assert.equal(humanizeSegment('search-monitor'), 'Search monitor')
  assert.equal(humanizeSegment('cm9x2k4l7p0q'), 'Details')
  assert.equal(humanizeSegment('3f2c1b7e-1111-4222-8333-444455556666'), 'Details')
  assert.equal(humanizeSegment('12345'), 'Details')
  assert.equal(humanizeSegment('%E0%A4%A'), '%E0%A4%A', 'a malformed escape is kept, not thrown')
})

test('breadcrumbs: Admin › department › module, module links only when a detail follows', () => {
  const rates = breadcrumbItems('/rates/plans')
  assert.equal(rates.length, 3)
  assert.equal(rates[0]!.label, 'Admin')
  assert.equal(rates[2]!.label, 'Rate Plans')
  assert.equal(rates[0]!.href, '/dashboard')
  assert.equal(rates[rates.length - 1]!.current, true)
  assert.equal(rates[rates.length - 1]!.href, undefined, 'the current page is not a link')
  const hotel = breadcrumbItems('/hotels/abc12345xyz')
  assert.equal(hotel[hotel.length - 1]!.label, 'Details')
  assert.equal(hotel[hotel.length - 2]!.href, '/hotels', 'the module links back when a detail follows')
  assert.ok(hotel[hotel.length - 1]!.current)
  assert.deepEqual(breadcrumbItems(null), breadcrumbItems('/dashboard'))
  assert.deepEqual(breadcrumbItems('/unknown-route').map((c) => c.label), ['Admin', 'Dashboard'])
})

test('breadcrumbs never repeat a department that carries the module name', () => {
  for (const section of navSections) for (const item of section.items) {
    const labels = breadcrumbItems(item.href).map((c) => c.label)
    assert.equal(new Set(labels).size, labels.length, `${item.href} has duplicate crumbs`)
  }
})

test('role-aware landing: first module the caller may use, null when none', () => {
  assert.equal(firstAccessibleRoute(() => true), navSections[0]!.items[0]!.href)
  assert.equal(firstAccessibleRoute(() => false), navSections.flatMap((s) => s.items).find((i) => !i.requires)?.href ?? null)
  const gated = navSections.flatMap((s) => s.items).filter((i) => i.requires)
  assert.ok(gated.length > 0)
  const onlyOne = gated[0]!
  const route = firstAccessibleRoute((p) => p === onlyOne.requires)
  assert.ok(route)
})

test('shell labels use the same active tenant as API calls', () => {
  const memberships = [{ tenantId: 'a', role: 'viewer' }, { tenantId: 'b', role: 'owner' }]
  assert.equal(activeMembership(memberships)?.tenantId, 'b')
  assert.equal(activeMembership([]), null)
  for (const file of ['Topbar.tsx', 'Sidebar.tsx']) {
    const src = readFileSync(join(root, 'components', 'layout', file), 'utf8')
    assert.match(src, /activeMembership\(identity\.memberships, activeTenantId\)/)
    assert.doesNotMatch(src, /memberships\[0\]/, `${file} must not label the wrong tenant`)
  }
})

test('shell accessibility: skip link, breadcrumb landmark, aria-current, dismissible menu', () => {
  const layout = (f: string) => readFileSync(join(root, 'components', 'layout', f), 'utf8')
  assert.match(layout('AdminShell.tsx'), /href="#main-content"/)
  assert.match(layout('AdminShell.tsx'), /id="main-content"/)
  assert.match(layout('Breadcrumbs.tsx'), /aria-label="Breadcrumb"/)
  assert.match(layout('Breadcrumbs.tsx'), /aria-current/)
  assert.match(layout('Sidebar.tsx'), /aria-current/)
  assert.match(layout('Topbar.tsx'), /Escape/)
})
