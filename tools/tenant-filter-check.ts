import { readFileSync, globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, relative } from 'node:path'
import type * as TS from 'typescript'

// The compiler is resolved from the API workspace that already depends on it, so the root manifest and lockfile stay untouched.
const ts = createRequire(resolve(process.cwd(), 'apps/api/package.json'))('typescript') as typeof TS

/**
 * Tenant-filter gate (ADR 0003, CLAUDE.md invariant 1).
 *
 * PostgreSQL forced RLS is the isolation boundary, but it only protects code that runs on the restricted runtime role
 * inside `withTenant`. This check is the application-layer second wall: every Prisma call on a model that has a
 * `tenantId` column must name the tenant explicitly, so a lost RLS context, a BYPASSRLS tenant-control/platform
 * connection or a raw-SQL path cannot widen a query across tenants.
 *
 * Findings:
 *  - missing-filter   read/update/delete `where` is an object literal with no tenantId (top level, AND, or a composite key)
 *  - missing-data     create/createMany `data` carries no tenantId
 *  - dynamic-where    `where` is not an object literal and could not be resolved to one that carries tenantId
 *  - unscoped-client  a tenant model is queried on the bare PrismaService, outside a withTenant/withSupplier/withPlatform transaction
 *  - raw-sql          $queryRaw/$executeRaw text on a tenant table with no tenant predicate
 *
 * Zero tolerance. The one audited exception is `// tenant-scope: <reason>` on the same or the preceding line (a reason is mandatory);
 * it is for queries that are cross-tenant or tenantless by design (login, platform operator, tenantless audit), never for convenience.
 * A `where` built elsewhere is not an exception: spread it and pin the tenant last, `where: { ...built, tenantId }`.
 * `--report` lists every finding with its location.
 */
const root = process.cwd()
const srcGlob = resolve(root, 'apps/api/src/**/*.ts')
const schema = readFileSync(resolve(root, 'apps/api/prisma/schema.prisma'), 'utf8')

const tenantModels = new Set<string>()
/** Models whose tenantId is optional: Prisma's types do not force it on create, so only these need the create-data check. */
const nullableTenantModels = new Set<string>()
for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const accessor = match[1][0].toLowerCase() + match[1].slice(1)
  const column = /^\s*tenantId\s+(\S+)/m.exec(match[2])
  if (!column) continue
  tenantModels.add(accessor)
  if (column[1].endsWith('?')) nullableTenantModels.add(accessor)
}
const tableOf = (accessor: string) => accessor[0].toUpperCase() + accessor.slice(1)

/**
 * Provisioning CLIs run once, by an operator, on the schema-owner connection (no RLS context, never in a request path), and legitimately
 * address rows across tenants. They are the only files this check does not read.
 */
const OWNER_CLI = /\/apps\/api\/src\/database\/[^/]+\.cli\.ts$/

const WHERE_OPS = new Set(['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'])
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn'])
const CONTEXT_WRAPPERS = new Set(['withTenant', 'withSupplier', 'withPlatform', 'withPlatformTenant'])

export type Finding = { file: string; scope: string; call: string; kind: string; line: number }

function propName(name: TS.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

/** True when an object literal names the tenant: a `tenantId` key, a composite key containing it, or an AND member that does. */
function literalNamesTenant(node: TS.ObjectLiteralExpression, resolveIdent: (id: TS.Identifier) => TS.Expression | undefined, depth = 0, scopeKeyIsTenant = false): boolean | 'dynamic' {
  let dynamic = false
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const target = ts.isIdentifier(prop.expression) ? resolveIdent(prop.expression) : undefined
      if (target && ts.isObjectLiteralExpression(target) && depth < 4) {
        const inner = literalNamesTenant(target, resolveIdent, depth + 1, scopeKeyIsTenant)
        if (inner === true) return true
        if (inner === 'dynamic') dynamic = true
      } else dynamic = true
      continue
    }
    const name = ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop) ? propName(prop.name) : undefined
    if (!name) continue
    if (name === 'tenantId' || /(^|_)tenantId(_|$)/.test(name) || (scopeKeyIsTenant && name === 'scopeKey')) return true
    if (name === 'AND' && ts.isPropertyAssignment(prop)) {
      const members = ts.isArrayLiteralExpression(prop.initializer) ? prop.initializer.elements : [prop.initializer]
      for (const member of members) {
        if (ts.isObjectLiteralExpression(member)) {
          const inner = literalNamesTenant(member, resolveIdent, depth + 1, scopeKeyIsTenant)
          if (inner === true) return true
          if (inner === 'dynamic') dynamic = true
        } else dynamic = true
      }
    }
  }
  return dynamic ? 'dynamic' : false
}

/** Raw SQL that reads or writes a tenant table (FROM/JOIN/INTO/UPDATE/DELETE FROM) without naming tenant_id or the tenant GUC. Catalog probes (has_table_privilege, pg_*) are not table access. */
function rawSqlUnscoped(sql: string): boolean {
  const touches = [...tenantModels].some((m) => new RegExp(`\\b(from|join|into|update)\\s+\\\\?"?${tableOf(m)}\\\\?"?(?![\\w])`, 'i').test(sql))
  return touches && !/tenant_id|tenantId|current_tenant|app\.current_tenant_id|tenantFilter/i.test(sql)
}

function enclosingScope(node: TS.Node): string {
  for (let current: TS.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) {
      const cls = current.parent && ts.isClassDeclaration(current.parent) && current.parent.name ? `${current.parent.name.text}.` : ''
      return `${cls}${current.name.getText()}`
    }
  }
  return '<module>'
}

function insideTenantContext(node: TS.Node): boolean {
  for (let current: TS.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent && ts.isCallExpression(current.parent)) {
      const callee = current.parent.expression
      if (ts.isPropertyAccessExpression(callee) && CONTEXT_WRAPPERS.has(callee.name.text)) return true
    }
  }
  return false
}

/** `tx`, `client`, `db` etc. are transaction clients; `this.prisma` / `prisma` / `this.db` are the bare service. */
function isBareService(receiver: TS.Expression): boolean {
  const text = receiver.getText()
  return /^(this\.)?(prisma|db|client)$/.test(text) || /^this\.\w*prisma\w*$/i.test(text)
}

export function analyze(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lines = source.split('\n')
  const waived = (line: number) => [line, line - 1].some((n) => /\/\/\s*tenant-scope:\s*\S{6,}/.test(lines[n - 1] ?? ''))
  const out: Finding[] = []

  const record = (node: TS.Node, call: string, kind: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
    if (waived(line)) return
    const scope = enclosingScope(node)
    out.push({ file: relative(root, file), scope, call, kind, line })
  }

  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const op = node.expression.name.text
      const target = node.expression.expression
      if (ts.isPropertyAccessExpression(target) && tenantModels.has(target.name.text) && (WHERE_OPS.has(op) || CREATE_OPS.has(op))) {
        const model = target.name.text
        const call = `${model}.${op}`
        const arg = node.arguments[0]
        const resolveIdent = (id: TS.Identifier): TS.Expression | undefined => {
          const symbolDecls = (function find(scopeNode: TS.Node): TS.VariableDeclaration | undefined {
            let found: TS.VariableDeclaration | undefined
            const walk = (n: TS.Node) => {
              if (found) return
              if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text && n.initializer && n.pos < id.pos) found = n
              ts.forEachChild(n, walk)
            }
            walk(scopeNode)
            return found
          })(enclosingFunction(node) ?? sf)
          return symbolDecls?.initializer
        }
        if (isBareService(target.expression) && !insideTenantContext(node)) record(node, call, 'unscoped-client')
        const objectArg = arg && ts.isObjectLiteralExpression(arg) ? arg : undefined
        if (WHERE_OPS.has(op)) {
          const whereProp = objectArg?.properties.find((p): p is TS.PropertyAssignment | TS.ShorthandPropertyAssignment => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propName(p.name) === 'where')
          if (!whereProp && objectArg && !objectArg.properties.some(ts.isSpreadAssignment)) {
            record(node, call, 'missing-filter')
          } else if (whereProp || !objectArg) {
            const value = whereProp ? (ts.isPropertyAssignment(whereProp) ? whereProp.initializer : whereProp.name) : arg
            let init: TS.Expression | undefined = value
            if (init && ts.isIdentifier(init)) init = resolveIdent(init) ?? init
            const branches = init && ts.isConditionalExpression(init) ? [init.whenTrue, init.whenFalse] : init ? [init] : []
            const verdicts = branches.map((b) => (ts.isObjectLiteralExpression(b) ? literalNamesTenant(b, resolveIdent, 0, model === 'complianceExportBatch') : 'dynamic'))
            if (verdicts.length === 0 || verdicts.includes('dynamic')) record(node, call, 'dynamic-where')
            else if (verdicts.includes(false)) record(node, call, 'missing-filter')
          } else record(node, call, 'dynamic-where')
        } else if (CREATE_OPS.has(op) && nullableTenantModels.has(model)) {
          const dataProp = objectArg?.properties.find((p): p is TS.PropertyAssignment | TS.ShorthandPropertyAssignment => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propName(p.name) === 'data')
          let data: TS.Expression | undefined = dataProp ? (ts.isPropertyAssignment(dataProp) ? dataProp.initializer : dataProp.name) : undefined
          if (data && ts.isIdentifier(data)) data = resolveIdent(data) ?? data
          const rows = data && ts.isArrayLiteralExpression(data) ? data.elements : data ? [data] : []
          if (!rows.length) record(node, call, 'missing-data')
          for (const row of rows) {
            if (ts.isObjectLiteralExpression(row) && literalNamesTenant(row, resolveIdent, 0, model === 'complianceExportBatch') === false && !/tenant\s*:\s*\{/.test(row.getText())) record(node, call, 'missing-data')
          }
        }
      }
      if (op === '$queryRawUnsafe' || op === '$executeRawUnsafe') {
        const sql = node.arguments.map((a) => a.getText()).join(' ')
        if (rawSqlUnscoped(sql)) record(node, op, 'raw-sql')
      }
    }
    if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag) && /^\$(query|execute)Raw$/.test(node.tag.name.text)) {
      if (rawSqlUnscoped(node.template.getText())) record(node, node.tag.name.text, 'raw-sql')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function enclosingFunction(node: TS.Node): TS.Node | undefined {
  for (let current: TS.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isArrowFunction(current) && ts.isVariableDeclaration(current.parent)) return current
  }
  return undefined
}

function main() {
  const files = globSync(srcGlob).filter((f) => !/\.(spec|e2e-spec|test)\.ts$/.test(f) && !OWNER_CLI.test(f)).sort()
  const findings = files.flatMap((file) => analyze(file, readFileSync(file, 'utf8')))
  if (process.argv.includes('--report')) {
    for (const f of findings) console.log(`${f.file}:${f.line}  ${f.kind.padEnd(15)} ${f.scope} -> ${f.call}`)
    console.log(`\n${findings.length} finding(s) in ${files.length} file(s); ${tenantModels.size} tenant models.`)
    return
  }
  if (findings.length) {
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.kind}: ${f.scope} calls ${f.call} without an explicit tenant scope (add tenantId, or "// tenant-scope: <reason>")`)
    process.exit(1)
  }
  console.log(`Tenant-filter rule holds across ${files.length} API file(s) and ${tenantModels.size} tenant models.`)
}

if (process.argv[1] && /tenant-filter-check\.ts$/.test(process.argv[1])) main()
