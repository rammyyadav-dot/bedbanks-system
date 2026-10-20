import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Workspace boundary gate (ADR 0075, CLAUDE.md "Dependency direction").
 *
 * Every browser app reaches the platform only through `@bedbanks/contracts` and the `/api/v1` proxy. Commercial rules, markup
 * resolution, supplier credentials and the database live behind the API, so no browser app may import them, and no app may
 * import another app's source. Shared packages never import apps.
 *
 * Findings:
 *  - cross-app        a file imports another app, by relative path or by its workspace package name
 *  - package-to-app   a shared package imports an app
 *  - server-only-dep  a browser app imports, or declares a dependency on, a server-only package (Prisma, connectors, NestJS)
 *
 * Integration tests (an app's `test/` directory or `*.integration.*`) may import another app to exercise the seam between them;
 * they are never bundled. They are still held to the server-only rule.
 */
const root = process.cwd()
const BROWSER_APPS = ['apps/admin', 'apps/agent', 'apps/supplier', 'apps/website'] as const
const ALL_APPS = [...BROWSER_APPS, 'apps/api'] as const
const PACKAGES = ['packages'] as const

/** Packages that only the API may load. A prefix match covers every connector workspace. */
const SERVER_ONLY = [/^@prisma\//, /^prisma$/, /^@bedbanks\/connectors(-|\/|$)/, /^@nestjs\//, /^@bedbanks\/api$/]

const appNames = new Map<string, string>()
for (const app of ALL_APPS) {
  const manifest = JSON.parse(readFileSync(join(root, app, 'package.json'), 'utf8')) as { name: string }
  appNames.set(manifest.name, app)
}

const INTEGRATION_TEST = /(^|\/)test\/|\.integration\./
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function filesIn(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', 'coverage', '.turbo'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) filesIn(path, found)
    else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/** The app directory (`apps/x`) a path belongs to, or undefined. */
function appOf(path: string): string | undefined {
  const rel = relative(root, path).split(sep).join('/')
  return ALL_APPS.find((app) => rel === app || rel.startsWith(`${app}/`))
}

const violations: string[] = []

function scan(dir: string, owner: string, isPackage: boolean) {
  const browser = (BROWSER_APPS as readonly string[]).includes(owner)
  for (const file of filesIn(join(root, dir))) {
    const where = relative(root, file)
    const seamTest = INTEGRATION_TEST.test(relative(join(root, dir), file).split(sep).join('/'))
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1]
      const target = specifier.startsWith('.') ? appOf(resolve(dirname(file), specifier)) : appNames.get(specifier.split('/').slice(0, 2).join('/'))
      if (target && target !== owner && !seamTest) {
        violations.push(`${where}: ${isPackage ? 'package-to-app' : 'cross-app'} import of ${target} ('${specifier}')`)
      }
      if (browser && SERVER_ONLY.some((pattern) => pattern.test(specifier))) {
        violations.push(`${where}: server-only-dep '${specifier}' imported by a browser app`)
      }
    }
  }
}

for (const app of ALL_APPS) scan(app, app, false)
for (const dir of PACKAGES) scan(dir, dir, true)

for (const app of BROWSER_APPS) {
  const manifest = JSON.parse(readFileSync(join(root, app, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]) {
    if (SERVER_ONLY.some((pattern) => pattern.test(name))) violations.push(`${app}/package.json: server-only-dep '${name}' declared by a browser app`)
  }
}

if (violations.length) {
  console.error(violations.join('\n'))
  process.exit(1)
}
console.log('Workspace boundaries hold: no cross-app imports, no package-to-app imports, no server-only packages in browser apps.')
