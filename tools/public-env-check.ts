import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const apps = ['apps/agent', 'apps/admin'] as const
const allowed: Record<(typeof apps)[number], ReadonlySet<string>> = {
  'apps/agent': new Set(['NEXT_PUBLIC_AGENT_API_URL']),
  'apps/admin': new Set(),
}
const secretName = /SECRET|PASSWORD|TOKEN|CREDENTIAL|DATABASE|PRIVATE|API_KEY|SUPPLIER_KEY|SUPPLIER_SECRET|WALLET/
const identifier = /NEXT_PUBLIC_[A-Z0-9_]+/g

function filesIn(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) filesIn(path, found)
    else if ((/\.(ts|tsx|js|mjs|cjs|json|md|css|html)$/.test(entry.name) || entry.name.startsWith('.env') || entry.name.endsWith('.example')) && !/\.(test|spec)\./.test(entry.name)) found.push(path)
  }
  return found
}

const violations: string[] = []
for (const app of apps) {
  for (const file of filesIn(join(root, app))) {
    const source = readFileSync(file, 'utf8')
    const names = new Set(source.match(identifier) ?? [])
    for (const name of names) {
      const where = relative(root, file)
      if (!allowed[app].has(name)) violations.push(`${where}: ${name} is not an allowed public variable`)
      if (secretName.test(name)) violations.push(`${where}: ${name} would expose a secret in the client bundle`)
    }
    if (file.endsWith('next.config.mjs') && /\benv\s*:/.test(source)) {
      violations.push(`${relative(root, file)}: next.config env inlines values into the client bundle`)
    }
  }
}

if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('Agent and Admin public env names are limited to the API base URL.')
