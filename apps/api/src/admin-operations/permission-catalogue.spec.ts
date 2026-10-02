import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEPARTMENT_IDS, FORBIDDEN_PERMISSION_KEYS, departments, permissionCatalogue, sidebarGroups, operationsPermissions, supplyPermissions,
} from '@bedbanks/contracts'

const srcRoot = join(__dirname, '..')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [full] : []
  })
}
const apiSource = sourceFiles(srcRoot).map((f) => readFileSync(f, 'utf8')).join('\n')
const enforcedKeys = permissionCatalogue.filter((p) => p.status === 'enforced').map((p) => p.key)
const plannedKeys = permissionCatalogue.filter((p) => p.status === 'planned')

describe('Enterprise Admin permission catalogue (ADR 0015)', () => {
  it('has unique keys', () => {
    const keys = permissionCatalogue.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('enforces exactly the keys the API contracts define, plus the booking and agent keys it already checks', () => {
    const contractKeys = [...Object.values(supplyPermissions), ...Object.values(operationsPermissions)]
    for (const key of contractKeys) expect(enforcedKeys).toContain(key)
    for (const key of enforcedKeys) expect(apiSource).toContain(`'${key}'`)
  })

  it('does not enforce, check or grant a planned permission anywhere in the API', () => {
    for (const { key } of plannedKeys) expect(apiSource).not.toContain(`'${key}'`)
  })

  it('refines only enforced keys', () => {
    for (const p of plannedKeys) if (p.refines) expect(enforcedKeys).toContain(p.refines)
  })

  it('never defines a forbidden permission', () => {
    for (const key of FORBIDDEN_PERMISSION_KEYS) expect(permissionCatalogue.map((p) => p.key)).not.toContain(key)
  })

  it('never offers a way to edit held or sold inventory, balances or booking status', () => {
    for (const p of permissionCatalogue) expect(p.key).not.toMatch(/\.(held|sold)\.|balance\.update|status\.update|^booking\.confirm$/)
  })

  it('classifies every sensitive action: mutations that move money, bookings, roles or booking capability are S3', () => {
    const s3 = ['booking.reconcile', 'booking.cancel', 'refund.approve', 'adjustment.approve', 'credit_limit.approve', 'role_permission.assign', 'user_role.assign', 'connector.booking.activate', 'reconciliation.resolve']
    for (const key of s3) expect(permissionCatalogue.find((p) => p.key === key)?.actionClass).toBe('S3')
    for (const p of permissionCatalogue) if (p.key.endsWith('.read')) expect(p.actionClass).toBe('S0')
  })

  it('keeps platform authority in the platform scope and tenant work in the tenant scope', () => {
    for (const key of ['role_permission.assign', 'user_role.assign']) expect(permissionCatalogue.find((p) => p.key === key)?.scope).toBe('PLATFORM')
    for (const p of permissionCatalogue.filter((x) => x.status === 'enforced')) expect(p.scope).toBe('TENANT')
  })

  it('gates every live module with an enforced permission and gives planned modules no route', () => {
    for (const d of departments) for (const m of d.modules) {
      if (m.readiness === 'planned') expect(m.href).toBeUndefined()
      else { expect(m.href).toMatch(/^\//); if (m.requires) expect(enforcedKeys).toContain(m.requires) }
    }
  })

  it('lists every department once and routes each live module into exactly one sidebar group', () => {
    expect(departments.map((d) => d.id).sort()).toEqual([...DEPARTMENT_IDS].sort())
    const grouped = sidebarGroups.flatMap((g) => g.departments)
    expect(new Set(grouped).size).toBe(grouped.length)
    const liveDepartments = departments.filter((d) => d.modules.some((m) => m.readiness === 'live')).map((d) => d.id)
    for (const id of liveDepartments) expect(grouped).toContain(id)
  })
})
