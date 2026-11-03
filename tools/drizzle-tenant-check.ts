// ADR 0110: Drizzle reaches Postgres only through the tenant session hook, and the API does not take a second driver.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DRIZZLE_ENTRY = 'apps/api/src/database/tenant-session.ts'
const POOL_ENTRY = 'apps/api/src/database/tenant-drizzle.service.ts'

export function checkSource(file: string, text: string): string[] {
  const violations: string[] = []
  if (text.includes('@neondatabase/serverless')) violations.push(`${file}: @neondatabase/serverless is not a runtime driver (ADR 0067). Drizzle uses node-postgres.`)
  if (file !== DRIZZLE_ENTRY && /from\s+['"]drizzle-orm/.test(text)) violations.push(`${file}: import drizzle-orm only from ${DRIZZLE_ENTRY}, which sets app.current_tenant_id on every query`)
  if (file !== POOL_ENTRY && /new\s+Pool\s*\(/.test(text)) violations.push(`${file}: a node-postgres Pool is a connection pool. Open it only in ${POOL_ENTRY} (ADR 0110).`)
  return violations
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.(spec|test|e2e-spec)\./.test(entry) && !path.includes(`${join('apps', 'api', 'test')}`)) out.push(path)
  }
  return out
}

export function scanRepository(root: string): string[] {
  const violations: string[] = []
  for (const base of ['apps', 'packages', 'tools']) {
    for (const file of walk(join(root, base))) {
      const rel = relative(root, file).split('\\').join('/')
      if (rel === 'tools/drizzle-tenant-check.ts') continue
      violations.push(...checkSource(rel, readFileSync(file, 'utf8')))
    }
  }
  return violations
}

if (process.argv[1] && /drizzle-tenant-check\.ts$/.test(process.argv[1])) {
  const violations = scanRepository(process.cwd())
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exit(1)
  }
  console.log('Drizzle tenant check passed: every Drizzle client is the tenant session hook, and no serverless driver is imported.')
}
