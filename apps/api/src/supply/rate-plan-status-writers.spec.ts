import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Architecture guard (ADR 0041): the only application code that writes RatePlan.status is the readiness-gated transition in
 * SupplyService. A new writer (a helper, another service, raw SQL) must fail this test and be reviewed, not slip in.
 */
const root = join(__dirname, '..')
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return sources(path)
  return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
})

describe('RatePlan.status writers', () => {
  const files = sources(root).map((path) => ({ path: path.slice(root.length + 1), text: readFileSync(path, 'utf8') }))

  it('has exactly one ORM write that sets status, inside the transition', () => {
    const writers: string[] = []
    for (const { path, text } of files) {
      for (const match of text.matchAll(/\bratePlan\.(update|updateMany|upsert|create|createMany)\(/g)) {
        const window = text.slice(match.index, match.index! + 900)
        const data = /data:\s*\{([^}]*)\}/s.exec(window)?.[1] ?? ''
        if (/\bstatus\b/.test(data) || /\.\.\.\s*cloneDraftFields/.test(data)) writers.push(`${path}: ${match[1]}`)
      }
    }
    expect(writers).toEqual(['supply/supply.service.ts: updateMany', 'supply/supply.service.ts: create'])
  })

  it('the only create that carries a status is the clone, and it is forced to DRAFT', () => {
    expect(readFileSync(join(root, 'supply/rate-plan-activation.ts'), 'utf8')).toMatch(/status: 'DRAFT' as const/)
  })

  it('has no raw SQL that updates the rate plan table', () => {
    const offenders = files.filter(({ text }) => /\$(execute|query)Raw(Unsafe)?[\s\S]{0,300}UPDATE\s+"?(RatePlan|rate_plans?)"?/i.test(text)).map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('the generic update path refuses status before touching the database', () => {
    const service = readFileSync(join(root, 'supply/supply.service.ts'), 'utf8')
    const start = service.indexOf('async updateRatePlan(')
    const update = service.slice(start, service.indexOf('private async activationReadiness('))
    expect(update.slice(0, 400)).toContain('refuseStatusField(input)')
    expect(update).not.toMatch(/input\.status/)
  })
})
